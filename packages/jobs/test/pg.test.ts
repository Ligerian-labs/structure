import { describe } from "bun:test";
import * as SqlClient from "@effect/sql/SqlClient";
import { PgClient } from "@effect/sql-pg";
import { Readiness, Shutdown } from "@structure-ai/runtime";
import { Context, Duration, Effect, Exit, type Fiber, Layer, Redacted, Scope } from "effect";
import { migrate, Scheduler, schedulerLayer, tableNames } from "../src/index.js";
import { registerSchedulerScenarios, type SchedulerHarness } from "./scenarios.js";

const databaseUrl = process.env.DATABASE_URL;
const gated = databaseUrl === undefined ? describe.skip : describe;

gated("PostgreSQL scheduler (needs DATABASE_URL)", () => {
  registerSchedulerScenarios(async () => {
    const tablePrefix = `t${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}_`;
    const clock = { value: new Date("2026-08-20T12:00:00.000Z") };
    const tables = tableNames({ tablePrefix });

    const scope = Effect.runSync(Scope.make());
    const SchedulerLive = schedulerLayer({
      tablePrefix,
      now: () => clock.value,
      random: () => 0.5,
    }).pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(databaseUrl as string) })));

    const context = await Effect.runPromise(Layer.buildWithScope(SchedulerLive, scope));
    const sql = Context.get(context, SqlClient.SqlClient);
    await Effect.runPromise(
      migrate({ tablePrefix }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
    );

    const shutdownContext = await Effect.runPromise(
      Layer.buildWithScope(
        Shutdown.layer({ finalizerTimeout: Duration.seconds(10) }).pipe(
          Layer.provide(Readiness.layer),
        ),
        scope,
      ),
    );
    const shutdown = Context.get(shutdownContext, Shutdown);
    const scheduler = Context.get(context, Scheduler);

    const harness: SchedulerHarness = {
      scheduler,
      clock,
      startWorker: (options): Promise<Fiber.RuntimeFiber<void, never>> =>
        Effect.runPromise(
          Effect.forkDaemon(
            scheduler
              .runWorker({
                ...(options?.batchSize === undefined ? {} : { batchSize: options.batchSize }),
                ...(options?.concurrency === undefined ? {} : { concurrency: options.concurrency }),
                ...(options?.pollMillis === undefined
                  ? {}
                  : { pollInterval: Duration.millis(options.pollMillis) }),
                ...(options?.leaseMillis === undefined
                  ? {}
                  : { lease: Duration.millis(options.leaseMillis) }),
              })
              .pipe(Effect.provideService(Shutdown, shutdown)),
          ),
        ),
      stopWorker: () => Effect.runPromise(shutdown.trigger("test-complete")),
      deadLetters: () =>
        Effect.runPromise(
          sql`SELECT job_name, attempts FROM ${sql(tables.deadLetters)} ORDER BY dead_at`,
        ),
      queueRows: () =>
        Effect.runPromise(
          sql<{
            id: string;
            status: string;
            attempt: number;
            lease_owner: string | null;
            lease_expires_at: Date | null;
          }>`SELECT id, status, attempt, lease_owner, lease_expires_at FROM ${sql(tables.queue)}`,
        ),
      reclaim: (jobId, owner, leaseMillis) =>
        Effect.runPromise(
          sql`
            UPDATE ${sql(tables.queue)}
            SET status = 'running', attempt = attempt + 1, lease_owner = ${owner},
                lease_expires_at = ${new Date(Date.now() + leaseMillis).toISOString()}
            WHERE id = ${jobId}
          `.pipe(Effect.asVoid),
        ),
      close: async () => {
        await Effect.runPromise(Effect.orDie(sql`DROP TABLE IF EXISTS ${sql(tables.queue)}`));
        await Effect.runPromise(Effect.orDie(sql`DROP TABLE IF EXISTS ${sql(tables.deadLetters)}`));
        await Effect.runPromise(Scope.close(scope, Exit.void));
      },
    };
    return harness;
  });
});
