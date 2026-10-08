import type { PersistenceError } from "@structure-ai/domain";
import { Context, Effect, Layer, PubSub, Queue, type Scope } from "effect";

/**
 * Commit notifications carry no event payloads. Consumers subscribe before
 * catching up from their durable checkpoint, then wait for another signal.
 * Each subscription coalesces pending signals into one bounded wake-up.
 */
export interface EventBusService {
  readonly notify: Effect.Effect<void, PersistenceError>;
  readonly subscribe: Effect.Effect<
    Effect.Effect<void, PersistenceError>,
    PersistenceError,
    Scope.Scope
  >;
}

/** One bus per event feed. Adapters may carry notifications across processes. */
export class EventBus extends Context.Tag("@structure-ai/eventsourcing/EventBus")<
  EventBus,
  EventBusService
>() {
  /** Scoped broadcast hub. Slow subscribers never block a committing writer. */
  static readonly make: Effect.Effect<EventBusService, never, Scope.Scope> = Effect.gen(
    function* () {
      const hub = yield* Effect.acquireRelease(PubSub.sliding<void>(1), PubSub.shutdown);
      return EventBus.of({
        notify: PubSub.publish(hub, undefined).pipe(Effect.asVoid),
        subscribe: PubSub.subscribe(hub).pipe(Effect.map((queue) => Queue.take(queue))),
      });
    },
  );

  static readonly layer: Layer.Layer<EventBus> = Layer.scoped(EventBus, EventBus.make);

  /**
   * Notify after a successful commit boundary. Wrap the outermost transaction
   * or command, never an append inside an open transaction. Failures, defects
   * and cancellation propagate without notifying. The result is preserved;
   * notification transport failures propagate as PersistenceError.
   */
  static notifyAfter<A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | PersistenceError, R | EventBus> {
    return Effect.gen(function* () {
      const bus = yield* EventBus;
      return yield* Effect.uninterruptibleMask((restore) =>
        restore(effect).pipe(Effect.tap(() => bus.notify)),
      );
    });
  }
}
