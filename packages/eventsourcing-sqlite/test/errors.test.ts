import { expect, test } from "bun:test";
import { SqlClient } from "@effect/sql/SqlClient";
import {
  AggregateStore,
  CheckpointStore,
  EventStore,
  Inbox,
  Outbox,
  SnapshotStore,
} from "@structure-ai/eventsourcing";
import { Cause, Effect, Exit, Option, Stream } from "effect";
import { layer } from "../src/index.js";

for (const storeName of ["events", "snapshots", "checkpoints", "outbox", "inbox"] as const) {
  test(`${storeName} SQL failures remain recoverable typed failures`, async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const eventStore = yield* EventStore;
        const snapshots = yield* SnapshotStore;
        const checkpoints = yield* CheckpointStore;
        const outbox = yield* Outbox;
        const inbox = yield* Inbox;
        yield* sql`DROP TABLE ${sql(storeName)}`;
        const operations: Record<typeof storeName, Effect.Effect<unknown, unknown>> = {
          events: Stream.runCollect(eventStore.read("Counter-a")),
          snapshots: snapshots.load("Counter-a"),
          checkpoints: checkpoints.load("projection"),
          outbox: outbox.pending(1),
          inbox: inbox.seen("consumer", "message"),
        };
        const exit = yield* Effect.exit(operations[storeName]);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.isDie(exit.cause)).toBe(false);
          const failure = Cause.failureOption(exit.cause);
          expect(Option.isSome(failure)).toBe(true);
          if (Option.isSome(failure)) {
            expect(failure.value).toMatchObject({ _tag: "PersistenceError" });
          }
        }
      }).pipe(Effect.provide(layer({ filename: ":memory:" }))),
    );
  });
}

test("unserializable data is a typed persistence failure before any write", async () => {
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  await Effect.runPromise(
    Effect.gen(function* () {
      const events = yield* EventStore;
      const snapshots = yield* SnapshotStore;
      const outbox = yield* Outbox;
      const operations: ReadonlyArray<Effect.Effect<unknown, unknown>> = [
        Effect.suspend(() => snapshots.save("Thing-1", { version: 1, state: cyclic })),
        Effect.suspend(() =>
          events.append("Thing-1", 0, [
            {
              type: "Created",
              schemaVersion: 1,
              payload: cyclic,
              metadata: {
                eventId: "event-1",
                occurredAt: "2026-09-16T00:00:00Z",
                aggregateName: "Thing",
                aggregateId: "1",
                aggregateVersion: 1,
              },
            },
          ]),
        ),
        Effect.suspend(() =>
          outbox.enqueue([{ id: "message", topic: "things", payload: cyclic, metadata: {} }]),
        ),
      ];
      for (const operation of operations) {
        const exit = yield* Effect.exit(operation);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.defects(exit.cause).length).toBe(0);
          expect(Cause.failureOption(exit.cause)).toMatchObject({
            value: { _tag: "PersistenceError" },
          });
        }
      }
      expect((yield* Stream.runCollect(events.read("Thing-1"))).length).toBe(0);
    }).pipe(Effect.provide(layer({ filename: ":memory:" }))),
  );
});

test("corrupt stored JSON is recoverable with catchTag", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const snapshots = yield* SnapshotStore;
      yield* sql`INSERT INTO snapshots (stream_name, state, version) VALUES ('Thing-1', '{', 1)`;
      const error = yield* snapshots
        .load("Thing-1")
        .pipe(Effect.catchTag("PersistenceError", Effect.succeed));
      expect(error).toMatchObject({ _tag: "PersistenceError", operation: "snapshot.decode" });
    }).pipe(Effect.provide(layer({ filename: ":memory:" }))),
  );
});

test("a live adapter outage is recoverable through AggregateStore", async () => {
  const { Counter, counterRegistry } = await import("./fixtures.js");
  const recovered = await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const aggregate = yield* AggregateStore.make(Counter, counterRegistry);
      yield* sql`DROP TABLE events`;
      return yield* aggregate
        .load("1")
        .pipe(Effect.catchTag("PersistenceError", () => Effect.succeed("recovered" as const)));
    }).pipe(Effect.provide(layer({ filename: ":memory:" }))),
  );
  expect(recovered).toBe("recovered");
});
