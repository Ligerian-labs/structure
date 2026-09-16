import { expect, test } from "bun:test";
import * as Reactivity from "@effect/experimental/Reactivity";
import * as SqlClient from "@effect/sql/SqlClient";
import { SqlError } from "@effect/sql/SqlError";
import * as Statement from "@effect/sql/Statement";
import { Readiness, Shutdown } from "@structure-ai/runtime";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { migrate, Scheduler, schedulerLayer } from "../src/index.js";

const outage = new SqlError({ cause: new Error("database unavailable") });
const sqlLayer = Layer.effect(
  SqlClient.SqlClient,
  SqlClient.make({
    acquirer: Effect.fail(outage),
    compiler: Statement.makeCompilerSqlite(),
    spanAttributes: [],
  }),
).pipe(Layer.provide(Reactivity.layer));
const services = Layer.mergeAll(
  schedulerLayer().pipe(Layer.provide(sqlLayer)),
  Shutdown.layer().pipe(Layer.provide(Readiness.layer)),
);

test("worker claim failures stay typed and retain the SQL cause", async () => {
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const scheduler = yield* Scheduler;
      return yield* scheduler.runWorker();
    }).pipe(Effect.provide(services)),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    expect(Cause.defects(exit.cause).length).toBe(0);
    const failure = Cause.failureOption(exit.cause);
    expect(Option.isSome(failure)).toBe(true);
    if (Option.isSome(failure))
      expect(failure.value).toMatchObject({ _tag: "JobQueueError", cause: outage });
  }
});

test("migration failures stay in the SQL error channel", async () => {
  const exit = await Effect.runPromiseExit(migrate().pipe(Effect.provide(sqlLayer)));
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) expect(Cause.failureOption(exit.cause)).toEqual(Option.some(outage));
});

for (const mode of ["heartbeat", "completion", "defect", "compound"] as const) {
  test(`worker supervises ${mode} failures from an execution`, async () => {
    const { Stream, Schema, FiberId } = await import("effect");
    let claimed = false;
    const defect = new Error("handler bug");
    const execute = (query: string) =>
      Effect.suspend(() => {
        if (query.includes("WITH picked AS")) {
          if (claimed) return Effect.succeed([]);
          claimed = true;
          return Effect.succeed([
            {
              id: "job-1",
              job_name: "test",
              payload: "{}",
              attempt: 1,
              max_attempts: 2,
              cron_expr: null,
              cron_timezone: null,
              correlation_id: null,
              run_at: new Date(),
              lease_owner: "owner",
            },
          ]);
        }
        if (
          (mode === "heartbeat" && query.includes("SET lease_expires_at")) ||
          (mode === "completion" && query.includes("DELETE FROM"))
        )
          return Effect.fail(outage);
        return Effect.succeed([]);
      });
    const connection = {
      execute,
      executeRaw: execute,
      executeUnprepared: execute,
      executeValues: () => Effect.succeed([]),
      executeStream: () => Stream.empty,
    };
    const mockSql = Layer.effect(
      SqlClient.SqlClient,
      SqlClient.make({
        acquirer: Effect.succeed(connection),
        compiler: Statement.makeCompilerSqlite(),
        spanAttributes: [],
      }),
    ).pipe(Layer.provide(Reactivity.layer));
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const scheduler = yield* Scheduler;
        yield* scheduler.register({
          name: "test",
          payloadSchema: Schema.parseJson(Schema.Struct({})),
          handle: () =>
            mode === "compound"
              ? Effect.failCause(
                  Cause.parallel(
                    Cause.fail({ reason: "retry", classification: "transient" as const }),
                    Cause.interrupt(FiberId.none),
                  ),
                )
              : mode === "heartbeat"
                ? Effect.never
                : mode === "defect"
                  ? Effect.die(defect)
                  : Effect.void,
        });
        yield* scheduler.runWorker({ pollInterval: "1 millis", lease: "30 millis" });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            schedulerLayer().pipe(Layer.provide(mockSql)),
            Shutdown.layer().pipe(Layer.provide(Readiness.layer)),
          ),
        ),
        Effect.timeout("1 second"),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      if (mode === "defect") {
        expect(Cause.pretty(exit.cause)).toContain("Error: handler bug");
        expect([...Cause.defects(exit.cause)]).toHaveLength(1);
        expect([...Cause.failures(exit.cause)]).toEqual([]);
      } else if (mode === "compound") {
        expect(Cause.isInterrupted(exit.cause)).toBe(true);
        expect([...Cause.failures(exit.cause)]).toContainEqual({
          reason: "retry",
          classification: "transient",
        });
      } else {
        expect([...Cause.defects(exit.cause)]).toEqual([]);
        expect(Cause.failureOption(exit.cause)).toMatchObject({
          value: { _tag: "JobQueueError", cause: outage },
        });
      }
    }
  });
}
