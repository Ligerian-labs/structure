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
 */
export class Shutdown extends Context.Tag("@structure/runtime/Shutdown")<
  Shutdown,
  {
    readonly isShuttingDown: Effect.Effect<boolean>;
    readonly onShutdown: (name: string, finalizer: Effect.Effect<void>) => Effect.Effect<void>;
    readonly trigger: (reason: string) => Effect.Effect<void>;
    /** Blocks until shutdown is triggered; resolves with the reason. */
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
    const finalizers = yield* Ref.make<ReadonlyArray<RegisteredFinalizer>>([]);

    const runFinalizer = (registered: RegisteredFinalizer): Effect.Effect<void> =>
      registered.finalizer.pipe(
        Effect.timeout(finalizerTimeout),
        Effect.catchAllCause((cause) =>
          Effect.logWarning(
            `shutdown finalizer "${registered.name}" failed or timed out; skipping`,
            cause,
          ),
        ),
      );

    const trigger = (triggerReason: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const alreadyTriggered = yield* Ref.getAndSet(started, true);
        if (alreadyTriggered) return;
        yield* Deferred.succeed(reason, triggerReason);
        yield* readiness.setUnready;
        const registered = yield* Ref.get(finalizers);
        yield* Effect.forEach([...registered].reverse(), runFinalizer, { discard: true });
      });

    return {
      isShuttingDown: Ref.get(started),
      onShutdown: (name, finalizer) =>
        Ref.update(finalizers, (list) => [...list, { name, finalizer }]),
      trigger,
      awaitShutdown: Deferred.await(reason),
    };
  });
