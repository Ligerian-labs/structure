import { Context, Deferred, Duration, Effect, Layer, Ref } from "effect";
import { Readiness } from "./Readiness.js";

interface RegisteredFinalizer {
  readonly name: string;
  readonly finalizer: Effect.Effect<void>;
}

export interface ShutdownOptions {
  /** Upper bound for each individual finalizer. Default: 5 seconds. */
  readonly finalizerTimeout?: Duration.Duration;
}

/**
 * In-process shutdown coordinator, usable without OS signals. `trigger` is
 * idempotent: the first call marks the process as shutting down, flips
 * `Readiness` to unready, then drains registered finalizers in reverse
 * registration order. Each finalizer is bounded by `finalizerTimeout`; a slow
 * or failing finalizer is logged and skipped so it never blocks the rest.
 *
 * The drain runs on its own daemon fiber, so it survives the interruption of
 * whichever fiber triggered it (a signal arriving while the program itself is
 * draining, for instance) and the per-finalizer timeout holds even when
 * `trigger` is called from an interruption handler. Every caller of `trigger`
 * returns once that drain completed.
 *
 * Signals are wired by `launch` (SIGTERM/SIGINT → `trigger(<signal>)`); this
 * layer itself never touches `process`.
 */
export class Shutdown extends Context.Tag("@structure-ai/runtime/Shutdown")<
  Shutdown,
  {
    readonly isShuttingDown: Effect.Effect<boolean>;
    readonly onShutdown: (name: string, finalizer: Effect.Effect<void>) => Effect.Effect<void>;
    /** Starts the drain (first call) and returns once every finalizer has run. */
    readonly trigger: (reason: string) => Effect.Effect<void>;
    /**
     * Blocks until shutdown is triggered and the finalizers have drained;
     * resolves with the reason (the signal name under `launch`). The program
     * is expected to end right after.
     */
    readonly awaitShutdown: Effect.Effect<string>;
  }
>() {
  static layer(options?: ShutdownOptions): Layer.Layer<Shutdown, never, Readiness> {
    return Layer.effect(Shutdown, make(options));
  }
}

const make = (
  options?: ShutdownOptions,
): Effect.Effect<Context.Tag.Service<Shutdown>, never, Readiness> =>
  Effect.gen(function* () {
    const finalizerTimeout = options?.finalizerTimeout ?? Duration.seconds(5);
    const readiness = yield* Readiness;
    const started = yield* Ref.make(false);
    const reason = yield* Deferred.make<string>();
    const drained = yield* Deferred.make<void>();
    const finalizers = yield* Ref.make<ReadonlyArray<RegisteredFinalizer>>([]);

    const runFinalizer = (registered: RegisteredFinalizer): Effect.Effect<void> =>
      registered.finalizer.pipe(
        // Interruptible on purpose: the timeout below cuts the finalizer by
        // interrupting it, which must work even when the drain was started
        // from an uninterruptible region (an `onInterrupt` handler).
        Effect.interruptible,
        Effect.timeout(finalizerTimeout),
        Effect.catchAllCause((cause) =>
          Effect.logWarning(
            `shutdown finalizer "${registered.name}" failed or timed out; skipping`,
            cause,
          ),
        ),
      );

    const drain: Effect.Effect<void> = Effect.gen(function* () {
      yield* readiness.setUnready;
      const registered = yield* Ref.get(finalizers);
      yield* Effect.forEach([...registered].reverse(), runFinalizer, { discard: true });
    }).pipe(Effect.ensuring(Deferred.succeed(drained, undefined)));

    const trigger = (triggerReason: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const alreadyTriggered = yield* Ref.getAndSet(started, true);
        if (!alreadyTriggered) {
          yield* Deferred.succeed(reason, triggerReason);
          yield* Effect.forkDaemon(drain);
        }
        yield* Deferred.await(drained);
      });

    return {
      isShuttingDown: Ref.get(started),
      onShutdown: (name, finalizer) =>
        Ref.update(finalizers, (list) => [...list, { name, finalizer }]),
      trigger,
      awaitShutdown: Effect.zipRight(Deferred.await(drained), Deferred.await(reason)),
    };
  });
