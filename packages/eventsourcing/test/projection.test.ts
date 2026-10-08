import { describe, expect, test } from "bun:test";
import { PersistenceError } from "@structure-ai/domain";
import { Deferred, Effect, Exit, Fiber, Layer, Ref, Stream, TestClock, TestContext } from "effect";
import {
  CheckpointStore,
  EventBus,
  EventStore,
  InMemoryCheckpointStore,
  InMemoryEventStore,
  Projection,
} from "../src/index.js";
import { type CounterEvent, counterRegistry, testMetadata } from "./fixtures.js";

const layer = Layer.mergeAll(InMemoryEventStore, InMemoryCheckpointStore);

const incremented = (amount: number) => ({
  type: "Incremented",
  schemaVersion: 1,
  payload: { _tag: "Incremented", amount },
  metadata: testMetadata(amount),
});

describe("Projection", () => {
  test("transport subscription and wait failures propagate through the worker", async () => {
    const failure = new PersistenceError({ operation: "EventBus.listen", cause: "disconnected" });
    const projection = Projection.make({
      name: "failed-listener",
      registry: counterRegistry,
      when: {},
    });
    for (const subscribe of [Effect.fail(failure), Effect.succeed(Effect.fail(failure))]) {
      const exit = await Effect.runPromise(
        Effect.exit(Projection.run(projection)).pipe(
          Effect.provideService(EventBus, EventBus.of({ notify: Effect.void, subscribe })),
          Effect.provide(layer),
          Effect.scoped,
          Effect.timeout("1 second"),
        ),
      );
      expect(exit).toEqual(Exit.fail(failure));
    }
  });

  test("subscribes before the initial empty read, preventing a lost startup wake-up", async () => {
    const program = Effect.gen(function* () {
      const store = yield* EventStore;
      const delivered = yield* Deferred.make<void>();
      const appended = yield* Ref.make(false);
      const observed = EventStore.of({
        ...store,
        readAll: (options) =>
          store.readAll(options).pipe(
            Stream.ensuring(
              Effect.gen(function* () {
                if (!(yield* Ref.getAndSet(appended, true))) {
                  yield* store.append("Counter-startup", 0, [incremented(1)]).pipe(Effect.orDie);
                }
              }),
            ),
          ),
      });
      const projection = Projection.make({
        name: "startup-race",
        registry: counterRegistry,
        when: { Incremented: () => Deferred.succeed(delivered, undefined).pipe(Effect.asVoid) },
      });
      yield* Projection.run(projection).pipe(
        Effect.provideService(EventStore, observed),
        Effect.forkScoped,
      );
      yield* Deferred.await(delivered);
    });
    await Effect.runPromise(
      program.pipe(Effect.provide(layer), Effect.scoped, Effect.timeout("2 seconds")),
    );
  });

  test("idle bus workers do not poll, and explicit reconciliation discovers unnotified writes", async () => {
    const program = Effect.gen(function* () {
      const store = yield* EventStore;
      const quiet = yield* EventBus.make;
      const reads = yield* Ref.make(0);
      const initial = yield* Deferred.make<void>();
      const delivered = yield* Deferred.make<void>();
      const observed = EventStore.of({
        ...store,
        readAll: (options) =>
          Stream.unwrap(
            Ref.update(reads, (n) => n + 1).pipe(Effect.as(store.readAll(options))),
          ).pipe(Stream.ensuring(Deferred.succeed(initial, undefined))),
      });
      const projection = Projection.make({
        name: "quiet",
        registry: counterRegistry,
        when: { Incremented: () => Deferred.succeed(delivered, undefined).pipe(Effect.asVoid) },
      });
      const worker = yield* Projection.run(projection).pipe(
        Effect.provideService(EventStore, observed),
        Effect.provideService(EventBus, quiet),
        Effect.forkScoped,
      );
      yield* Deferred.await(initial);
      yield* TestClock.adjust("1 minute");
      expect(yield* Ref.get(reads)).toBe(1);
      yield* Fiber.interrupt(worker);

      const pollingReady = yield* Deferred.make<void>();
      const reconciliationStore = EventStore.of({
        ...store,
        readAll: (options) =>
          store.readAll(options).pipe(Stream.ensuring(Deferred.succeed(pollingReady, undefined))),
      });
      const reconciled = yield* Projection.run(projection, { pollInterval: "1 second" }).pipe(
        Effect.provideService(EventStore, reconciliationStore),
        Effect.provideService(EventBus, quiet),
        Effect.forkScoped,
      );
      yield* Deferred.await(pollingReady);
      // A different bus models a write from outside this worker's process.
      yield* store.append("Counter-external", 0, [incremented(1)]);
      yield* TestClock.adjust("1 second");
      yield* Deferred.await(delivered);
      yield* Fiber.interrupt(reconciled);
    });
    await Effect.runPromise(
      program.pipe(Effect.provide(layer), Effect.provide(TestContext.TestContext), Effect.scoped),
    );
  });

  test("without a bus run retains its polling behavior", async () => {
    const program = Effect.gen(function* () {
      const store = yield* EventStore;
      const ready = yield* Deferred.make<void>();
      const delivered = yield* Deferred.make<void>();
      const observed = EventStore.of({
        ...store,
        readAll: (options) =>
          store.readAll(options).pipe(Stream.ensuring(Deferred.succeed(ready, undefined))),
      });
      const projection = Projection.make({
        name: "polling",
        registry: counterRegistry,
        when: { Incremented: () => Deferred.succeed(delivered, undefined).pipe(Effect.asVoid) },
      });
      yield* Projection.run(projection).pipe(
        Effect.provideService(EventStore, observed),
        Effect.forkScoped,
      );
      yield* Deferred.await(ready);
      yield* store.append("Counter-polled", 0, [incremented(1)]);
      yield* TestClock.adjust("500 millis");
      yield* Deferred.await(delivered);
    });
    const pollingLayer = Layer.merge(
      Layer.effect(EventStore, EventStore).pipe(Layer.provide(InMemoryEventStore)),
      InMemoryCheckpointStore,
    );
    await Effect.runPromise(
      program.pipe(
        Effect.provide(pollingLayer),
        Effect.provide(TestContext.TestContext),
        Effect.scoped,
      ),
    );
  });

  test("broadcast wakes independent projections and events arriving during a handler keep global order", async () => {
    const program = Effect.gen(function* () {
      const store = yield* EventStore;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const firstDone = yield* Deferred.make<void>();
      const secondDone = yield* Deferred.make<void>();
      const firstPositions: Array<bigint> = [];
      const secondPositions: Array<bigint> = [];
      const first = Projection.make({
        name: "first",
        registry: counterRegistry,
        when: {
          Incremented: (_event, stored) =>
            Effect.gen(function* () {
              firstPositions.push(stored.position);
              if (stored.position === 1n) {
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(release);
              }
              if (stored.position === 3n) yield* Deferred.succeed(firstDone, undefined);
            }),
        },
      });
      const second = Projection.make({
        name: "second",
        registry: counterRegistry,
        when: {
          Incremented: (_event, stored) =>
            Effect.sync(() => {
              secondPositions.push(stored.position);
            }).pipe(
              Effect.andThen(
                stored.position === 3n
                  ? Deferred.succeed(secondDone, undefined).pipe(Effect.asVoid)
                  : Effect.void,
              ),
            ),
        },
      });
      // Also proves catch-up includes events committed before subscription.
      yield* store.append("Counter-first", 0, [incremented(1)]);
      yield* Projection.run(first, { batchSize: 1 }).pipe(Effect.forkScoped);
      yield* Projection.run(second, { batchSize: 1 }).pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      yield* store.append("Counter-second", 0, [incremented(2), incremented(3)]);
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(firstDone);
      yield* Deferred.await(secondDone);
      expect(firstPositions).toEqual([1n, 2n, 3n]);
      expect(secondPositions).toEqual([1n, 2n, 3n]);
    });
    await Effect.runPromise(
      program.pipe(Effect.provide(layer), Effect.scoped, Effect.timeout("2 seconds")),
    );
  });

  test("a failed bus worker leaves its batch checkpoint unchanged and restarting replays it", async () => {
    const program = Effect.gen(function* () {
      const store = yield* EventStore;
      const checkpoints = yield* CheckpointStore;
      const fail = yield* Ref.make(true);
      const resumed = yield* Deferred.make<void>();
      const applied: Array<bigint> = [];
      const projection = Projection.make<CounterEvent, string>({
        name: "restart",
        registry: counterRegistry,
        when: {
          Incremented: (_event, stored) =>
            Effect.gen(function* () {
              if (stored.position === 2n && (yield* Ref.get(fail)))
                return yield* Effect.fail("poisoned");
              applied.push(stored.position);
              if (stored.position === 2n) yield* Deferred.succeed(resumed, undefined);
            }),
        },
      });
      yield* store.append("Counter-restart", 0, [incremented(1), incremented(2)]);
      const failed = yield* Projection.run(projection).pipe(Effect.forkScoped);
      const exit = yield* Fiber.await(failed);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(yield* checkpoints.load("restart")).toBe(0n);
      yield* Ref.set(fail, false);
      yield* Projection.run(projection).pipe(Effect.forkScoped);
      yield* Deferred.await(resumed);
      expect(applied).toEqual([1n, 1n, 2n]);
    });
    await Effect.runPromise(
      program.pipe(Effect.provide(layer), Effect.scoped, Effect.timeout("2 seconds")),
    );
  });

  test("run wakes on an append while its polling interval has not elapsed", async () => {
    const program = Effect.gen(function* () {
      const caughtUp = yield* Deferred.make<void>();
      const delivered = yield* Deferred.make<void>();
      const store = yield* EventStore;
      const observed = EventStore.of({
        ...store,
        readAll: (options) => {
          // The first read happens before the append, with an empty feed.
          return store
            .readAll(options)
            .pipe(Stream.ensuring(Deferred.succeed(caughtUp, undefined)));
        },
      });
      const projection = Projection.make({
        name: "append-wakeup",
        registry: counterRegistry,
        when: { Incremented: () => Deferred.succeed(delivered, undefined).pipe(Effect.asVoid) },
      });
      const worker = yield* Projection.run(projection, { pollInterval: "1 hour" }).pipe(
        Effect.provideService(EventStore, observed),
        Effect.forkScoped,
      );
      yield* Deferred.await(caughtUp);
      yield* store.append("Counter-wake", 0, [incremented(1)]);
      yield* Deferred.await(delivered).pipe(Effect.timeout("250 millis"));
      yield* Fiber.interrupt(worker);
    });
    await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped));
  });
  test("catchup applies in global order, checkpoints, resumes idempotently, rebuild replays with live:false", async () => {
    const program = Effect.gen(function* () {
      const applied = yield* Ref.make<ReadonlyArray<string>>([]);
      const lives = yield* Ref.make<ReadonlyArray<boolean>>([]);
      const projection = Projection.make({
        name: "counter-totals",
        registry: counterRegistry,
        when: {
          Incremented: (event, stored, context) =>
            Effect.gen(function* () {
              yield* Ref.update(applied, (list) => [
                ...list,
                `${stored.streamName}@${stored.position}:${event.amount}`,
              ]);
              yield* Ref.update(lives, (list) => [...list, context.live]);
            }),
        },
      });

      const store = yield* EventStore;
      yield* store.append("Counter-p1", 0, [incremented(1)]);
      yield* store.append("Counter-p2", 0, [incremented(2)]);
      yield* store.append("Counter-p1", 1, [incremented(3)]);

      // First catchup: everything, in global order, live.
      const first = yield* Projection.catchup(projection, { batchSize: 2 });
      expect(first).toEqual({ processed: 3, skipped: 0 });
      expect(yield* Ref.get(applied)).toEqual([
        "Counter-p1@1:1",
        "Counter-p2@2:2",
        "Counter-p1@3:3",
      ]);
      expect(yield* Ref.get(lives)).toEqual([true, true, true]);
      const checkpoints = yield* CheckpointStore;
      expect(yield* checkpoints.load("counter-totals")).toBe(3n);

      // Re-running applies nothing (checkpoint prevents re-delivery).
      const again = yield* Projection.catchup(projection);
      expect(again).toEqual({ processed: 0, skipped: 0 });
      expect((yield* Ref.get(applied)).length).toBe(3);

      // New events are picked up from the checkpoint.
      yield* store.append("Counter-p2", 1, [incremented(4)]);
      const resumed = yield* Projection.catchup(projection);
      expect(resumed).toEqual({ processed: 1, skipped: 0 });
      expect((yield* Ref.get(applied)).length).toBe(4);
      expect(yield* checkpoints.load("counter-totals")).toBe(4n);

      // Rebuild: reset, zero the checkpoint, replay everything with live:false.
      yield* Ref.set(lives, []);
      const rebuilt = yield* Projection.rebuild(projection, Ref.set(applied, []));
      expect(rebuilt).toEqual({ processed: 4, skipped: 0 });
      expect((yield* Ref.get(applied)).length).toBe(4);
      expect(yield* Ref.get(lives)).toEqual([false, false, false, false]);
      expect(yield* checkpoints.load("counter-totals")).toBe(4n);
    });
    await Effect.runPromise(program.pipe(Effect.provide(layer)));
  });

  test("events with a type unknown to the registry are skipped and counted", async () => {
    const program = Effect.gen(function* () {
      const applied = yield* Ref.make(0);
      const projection = Projection.make({
        name: "skipper",
        registry: counterRegistry,
        when: {
          Incremented: () => Ref.update(applied, (n) => n + 1),
        },
      });
      const store = yield* EventStore;
      yield* store.append("Counter-s1", 0, [
        incremented(1),
        { type: "LegacyThing", schemaVersion: 1, payload: {}, metadata: testMetadata(2) },
        incremented(3),
      ]);
      const stats = yield* Projection.catchup(projection);
      expect(stats).toEqual({ processed: 2, skipped: 1 });
      expect(yield* Ref.get(applied)).toBe(2);
      const checkpoints = yield* CheckpointStore;
      expect(yield* checkpoints.load("skipper")).toBe(3n);
    });
    await Effect.runPromise(program.pipe(Effect.provide(layer)));
  });
});
