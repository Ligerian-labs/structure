import { describe, expect, test } from "bun:test";
import { Cause, Deferred, Effect, Exit, Fiber, Option, Scope } from "effect";
import { EventBus, EventStore, InMemoryEventStore } from "../src/index.js";
import { testMetadata } from "./fixtures.js";

describe("EventBus", () => {
  test("broadcasts a coalesced wake-up to every subscriber without blocking publishers", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const bus = yield* EventBus.make;
          const first = yield* bus.subscribe;
          const second = yield* bus.subscribe;
          yield* Effect.forEach(Array.from({ length: 1000 }), () => bus.notify, { discard: true });
          yield* first;
          yield* second;
          const pending = yield* Effect.forkScoped(first);
          yield* Effect.yieldNow();
          expect(Option.isNone(yield* Fiber.poll(pending))).toBe(true);
          yield* bus.notify;
          yield* Fiber.join(pending);
        }),
      ).pipe(Effect.timeout("2 seconds")),
    );
  });

  test("notifyAfter preserves results and only notifies on success", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const bus = yield* EventBus;
        const wait = yield* bus.subscribe;
        expect(yield* EventBus.notifyAfter(Effect.succeed(42))).toBe(42);
        yield* wait;

        const cause = Cause.parallel(Cause.fail("rejected"), Cause.die("defect"));
        const failed = yield* Effect.exit(EventBus.notifyAfter(Effect.failCause(cause)));
        expect(failed).toEqual(Exit.failCause(cause));
        const pending = yield* Effect.forkScoped(wait);
        yield* Effect.yieldNow();
        expect(Option.isNone(yield* Fiber.poll(pending))).toBe(true);
        yield* bus.notify;
        yield* Fiber.join(pending);
      }).pipe(Effect.provide(EventBus.layer), Effect.scoped, Effect.timeout("2 seconds")),
    );
  });

  test("cancelling an unfinished commit does not notify", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const bus = yield* EventBus;
        const wait = yield* bus.subscribe;
        const started = yield* Deferred.make<void>();
        const writer = yield* EventBus.notifyAfter(
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        const exit = yield* Fiber.interrupt(writer);
        expect(Exit.isFailure(exit) && Cause.isInterrupted(exit.cause)).toBe(true);
        const pending = yield* Effect.forkScoped(wait);
        yield* Effect.yieldNow();
        expect(Option.isNone(yield* Fiber.poll(pending))).toBe(true);
        yield* bus.notify;
        yield* Fiber.join(pending);
      }).pipe(Effect.provide(EventBus.layer), Effect.scoped, Effect.timeout("2 seconds")),
    );
  });

  test("closing a subscriber scope releases its waiter and leaves the bus usable", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const bus = yield* EventBus.make;
          const subscriptionScope = yield* Scope.make();
          const wait = yield* bus.subscribe.pipe(
            Effect.provideService(Scope.Scope, subscriptionScope),
          );
          const worker = yield* Effect.forkScoped(wait);
          yield* Scope.close(subscriptionScope, Exit.void);
          const exit = yield* Fiber.await(worker);
          expect(Exit.isFailure(exit) && Cause.isInterrupted(exit.cause)).toBe(true);
          const next = yield* bus.subscribe;
          yield* bus.notify;
          yield* next;
        }),
      ).pipe(Effect.timeout("2 seconds")),
    );
  });

  test("empty and conflicting in-memory appends do not notify", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* EventStore;
        const bus = yield* EventBus;
        const wait = yield* bus.subscribe;
        yield* store.append("Counter-quiet", 0, []);
        const failed = yield* Effect.exit(store.append("Counter-quiet", 1, []));
        expect(Exit.isFailure(failed)).toBe(true);
        const pending = yield* Effect.forkScoped(wait);
        yield* Effect.yieldNow();
        expect(Option.isNone(yield* Fiber.poll(pending))).toBe(true);
        yield* store.append("Counter-quiet", 0, [
          {
            type: "Incremented",
            schemaVersion: 1,
            payload: { _tag: "Incremented", amount: 1 },
            metadata: testMetadata(1),
          },
        ]);
        yield* Fiber.join(pending);
      }).pipe(Effect.provide(InMemoryEventStore), Effect.scoped, Effect.timeout("2 seconds")),
    );
  });
});
