import { describe, expect, test } from "bun:test";
import { ConcurrencyConflict } from "@structure-ai/domain";
import { Chunk, Effect, Layer, Option, Ref, Stream } from "effect";
import {
  AggregateStore,
  EventStore,
  InMemoryEventStore,
  InMemorySnapshotStore,
  SnapshotStore,
} from "../src/index.js";
import { Counter, counterRegistry } from "./fixtures.js";

describe("AggregateStore", () => {
  test("execute appends events and load rehydrates state and version", async () => {
    const program = Effect.gen(function* () {
      const counters = yield* AggregateStore.make(Counter, counterRegistry);
      const first = yield* counters.execute("c1", { _tag: "Increment", amount: 2 });
      expect(first.state).toEqual({ total: 2 });
      expect(first.version).toBe(1);
      expect(first.events.length).toBe(1);
      const second = yield* counters.execute("c1", { _tag: "Increment", amount: 3 });
      expect(second.state).toEqual({ total: 5 });
      expect(second.version).toBe(2);
      const loaded = yield* counters.load("c1");
      expect(loaded).toEqual({ state: { total: 5 }, version: 2 });
      const missing = yield* counters.load("nobody");
      expect(missing).toEqual({ state: { total: 0 }, version: 0 });
    });
    await Effect.runPromise(program.pipe(Effect.provide(InMemoryEventStore)));
  });

  test("execute stamps metadata and propagates correlation/causation", async () => {
    const program = Effect.gen(function* () {
      const counters = yield* AggregateStore.make(Counter, counterRegistry);
      yield* counters.execute(
        "c2",
        { _tag: "Increment", amount: 1 },
        { correlationId: "corr-1", causationId: "cause-1", actor: "ada" },
      );
      const store = yield* EventStore;
      const stored = Chunk.toReadonlyArray(yield* Stream.runCollect(store.read("Counter-c2")));
      expect(stored.length).toBe(1);
      const first = stored[0];
      if (first === undefined) {
        throw new Error("expected a stored event");
      }
      expect(first.metadata.correlationId).toBe("corr-1");
      expect(first.metadata.causationId).toBe("cause-1");
      expect(first.metadata.actor).toBe("ada");
      expect(first.metadata.aggregateName).toBe("Counter");
      expect(first.metadata.aggregateId).toBe("c2");
      expect(first.metadata.aggregateVersion).toBe(1);
      expect(first.metadata.eventId.length).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(first.metadata.occurredAt))).toBe(false);
    });
    await Effect.runPromise(program.pipe(Effect.provide(InMemoryEventStore)));
  });

  test("executeWithRetry survives injected concurrency conflicts", async () => {
    // Decorates the in-memory store so the first `failures` appends conflict.
    const flakyEventStore = (failures: number) =>
      Layer.effect(
        EventStore,
        Effect.gen(function* () {
          const inner = yield* EventStore;
          const remaining = yield* Ref.make(failures);
          return EventStore.of({
            ...inner,
            append: (streamName, expectedVersion, events) =>
              Effect.gen(function* () {
                const left = yield* Ref.getAndUpdate(remaining, (n) => n - 1);
                if (left > 0) {
                  return yield* Effect.fail(
                    new ConcurrencyConflict({
                      entity: "Counter",
                      id: "c3",
                      expectedVersion,
                      actualVersion: expectedVersion + 1,
                    }),
                  );
                }
                return yield* inner.append(streamName, expectedVersion, events);
              }),
          });
        }),
      ).pipe(Layer.provide(InMemoryEventStore));

    const program = Effect.gen(function* () {
      const counters = yield* AggregateStore.make(Counter, counterRegistry);
      const result = yield* counters.executeWithRetry("c3", { _tag: "Increment", amount: 4 });
      expect(result.state).toEqual({ total: 4 });
      expect(result.version).toBe(1);
    });
    await Effect.runPromise(program.pipe(Effect.provide(flakyEventStore(2))));
  });

  test("domain errors are not retried", async () => {
    const program = Effect.gen(function* () {
      const counters = yield* AggregateStore.make(Counter, counterRegistry);
      const exit = yield* Effect.either(
        counters.executeWithRetry("c4", { _tag: "Increment", amount: 0 }),
      );
      expect(exit._tag).toBe("Left");
      if (exit._tag === "Left") {
        expect(exit.left._tag).toBe("InvariantViolation");
      }
    });
    await Effect.runPromise(program.pipe(Effect.provide(InMemoryEventStore)));
  });

  test("snapshotEvery saves a snapshot and load skips already-folded events", async () => {
    const program = Effect.gen(function* () {
      const readCount = yield* Ref.make(0);
      const inner = yield* EventStore;
      // Counts every event streamed out of `read` to prove the snapshot is used.
      const counting = EventStore.of({
        ...inner,
        read: (streamName, options) =>
          inner
            .read(streamName, options)
            .pipe(Stream.tap(() => Ref.update(readCount, (n) => n + 1))),
      });
      const counters = yield* AggregateStore.make(Counter, counterRegistry, {
        snapshotEvery: 2,
      }).pipe(Effect.provideService(EventStore, counting));

      yield* counters.execute("c5", { _tag: "Increment", amount: 1 });
      yield* counters.execute("c5", { _tag: "Increment", amount: 2 });

      const snapshots = yield* SnapshotStore;
      const snapshot = yield* snapshots.load("Counter-c5");
      expect(Option.isSome(snapshot)).toBe(true);
      if (Option.isSome(snapshot)) {
        expect(snapshot.value.version).toBe(2);
        expect(snapshot.value.state).toEqual({ total: 3 });
      }

      yield* Ref.set(readCount, 0);
      const loaded = yield* counters.load("c5");
      expect(loaded).toEqual({ state: { total: 3 }, version: 2 });
      expect(yield* Ref.get(readCount)).toBe(0);

      yield* counters.execute("c5", { _tag: "Increment", amount: 4 });
      yield* Ref.set(readCount, 0);
      const reloaded = yield* counters.load("c5");
      expect(reloaded).toEqual({ state: { total: 7 }, version: 3 });
      expect(yield* Ref.get(readCount)).toBe(1);
    });
    await Effect.runPromise(
      program.pipe(Effect.provide(Layer.mergeAll(InMemoryEventStore, InMemorySnapshotStore))),
    );
  });
});
