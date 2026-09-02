import { Runtime } from "@effect/platform";
import { BunRuntime } from "@effect/platform-bun";
import { type ConfigIssue, ConfigLoadError } from "@structure-ai/config";
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FiberId,
  type Layer,
  Option,
} from "effect";
import { Shutdown } from "./Shutdown.js";

export interface LaunchOptions<R, LE> {
  /** Everything the program needs: config, telemetry, resources. */
  readonly layers: Layer.Layer<R, LE>;
  /**
   * Hard deadline for draining (finalizers, layer teardown) once the program
   * stops; if teardown overruns it the process exits with code 1.
   * Default: 30 seconds.
   */
  readonly gracePeriod?: Duration.Duration;
}

const isConfigLoadError = (error: unknown): error is ConfigLoadError =>
  error instanceof ConfigLoadError;

const SIGNALS = ["SIGTERM", "SIGINT"] as const;

/**
 * Ties the program to the `Shutdown` coordinator when its layers provide one
 * (no-op otherwise). The program runs on a daemon fiber (a child would be
 * interrupted together with the main fiber, before any handler runs) so that
 * a signal can let it finish on its own terms; every exit path below stops
 * that fiber before the main one ends:
 * - `signal` (an OS signal under `launch`, whatever the test injects under
 *   `runToCompletion`) resolves with a reason → `trigger(reason)`: readiness
 *   flips, finalizers drain, `awaitShutdown` resolves with that reason and the
 *   program ends. A program that does not end by itself (`Effect.never`-style
 *   servers) is interrupted once the drain completed;
 * - interruption of the main fiber (how `runMain` reacts to a signal) →
 *   `trigger("interrupted")`, awaited inside the interruption handler so the
 *   drain completes before the main fiber ends; the program fiber is stopped
 *   the same way afterwards.
 * Both paths converge on the same idempotent drain, so it does not matter
 * which listener fires first.
 */
const withShutdown = <A, E, R>(
  program: Effect.Effect<A, E, R>,
  signal: Effect.Effect<string> | undefined,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const shutdown = yield* Effect.serviceOption(Shutdown);
    if (Option.isNone(shutdown)) return yield* program;
    const { trigger } = shutdown.value;
    const running = yield* Effect.forkDaemon(program);
    const stop = (reason: string): Effect.Effect<void> =>
      trigger(reason).pipe(Effect.zipRight(Fiber.interrupt(running)), Effect.asVoid);
    if (signal !== undefined) {
      // A child fiber: interrupted with the program once everything ended.
      yield* Effect.fork(Effect.flatMap(signal, stop));
    }
    return yield* Fiber.join(running).pipe(Effect.onInterrupt(() => stop("interrupted")));
  });

/**
 * Production entrypoint wrapper around `BunRuntime.runMain`.
 *
 * Startup order comes from the layers: config loads and validates first, so a
 * `ConfigLoadError` is reported (every issue, via `Effect.logFatal`) and the
 * process exits with code 1 before any work is accepted.
 *
 * SIGTERM/SIGINT are routed into the `Shutdown` coordinator when the layers
 * provide one: `awaitShutdown` resolves with the signal name after the
 * registered finalizers drained (readiness flipped first), then the program
 * ends, layers tear down, and the process exits 0. `runMain`'s own reaction to
 * the signal (interrupting the main fiber) converges on the same drain, so
 * the order in which the two listeners fire does not matter. A second signal
 * ends the process immediately (default OS behavior). The whole teardown is
 * bounded by `gracePeriod`, after which the process exits 1.
 */
export const launch = <E, R, LE>(
  program: Effect.Effect<void, E, R>,
  options: LaunchOptions<R, LE>,
): void => {
  const gracePeriod = options.gracePeriod ?? Duration.seconds(30);
  let configFailed = false;
  // Armed when the program stops (completion, failure, or signal-driven
  // interrupt): teardown gets at most `gracePeriod` before a hard exit. The
  // timer is unref'd so it never keeps a cleanly-exiting process alive.
  const armDrainDeadline = Effect.sync(() => {
    const timer = setTimeout(() => {
      process.stderr.write(`shutdown grace period exceeded (${Duration.format(gracePeriod)})\n`);
      process.exit(1);
    }, Duration.toMillis(gracePeriod));
    timer.unref();
  });
  // Listeners go in before `runMain` installs its own, so a signal reaches
  // the coordinator with its name; they leave with the program.
  const signal = Deferred.unsafeMake<string>(FiberId.none);
  const listeners = SIGNALS.map((name) => {
    const listener = () => {
      Effect.runSync(armDrainDeadline);
      Deferred.unsafeDone(signal, Effect.succeed(name));
    };
    process.once(name, listener);
    return { name, listener };
  });
  const removeListeners = Effect.sync(() => {
    for (const { name, listener } of listeners) process.removeListener(name, listener);
  });
  const app = withShutdown(program, Deferred.await(signal)).pipe(
    Effect.onExit(() => armDrainDeadline),
    Effect.ensuring(removeListeners),
    Effect.provide(options.layers),
    Effect.catchAll((error) =>
      isConfigLoadError(error)
        ? Effect.zipRight(
            Effect.sync(() => {
              configFailed = true;
            }),
            Effect.logFatal(error.message),
          )
        : Effect.fail(error),
    ),
  );
  BunRuntime.runMain(app, {
    // The app picks its logger through the observability layer; without this
    // `runMain` installs Bun's pretty logger first and `layerJson` would sit
    // next to it, printing every record twice.
    disablePrettyLogger: true,
    teardown: (exit, onExit) => {
      if (configFailed) {
        onExit(1);
        return;
      }
      Runtime.defaultTeardown(exit, onExit);
    },
  });
};

/**
 * Exit information from {@link runToCompletion}. A program stopped through the
 * shutdown path (signal or interruption, nothing else failing) is a `Success`,
 * matching the exit code 0 `launch` produces for it.
 */
export type RunOutcome =
  | { readonly _tag: "Success" }
  | { readonly _tag: "ConfigInvalid"; readonly issues: ReadonlyArray<ConfigIssue> }
  | { readonly _tag: "Failed"; readonly cause: Cause.Cause<unknown> };

export interface RunOptions {
  /**
   * Stand-in for an OS signal: when it resolves, its value becomes the
   * shutdown reason (`Shutdown.trigger(reason)`), exactly as SIGTERM/SIGINT
   * do under {@link launch}. Typically `Deferred.await(stop)`. Ignored when
   * the layers provide no `Shutdown`.
   */
  readonly signal?: Effect.Effect<string>;
}

/**
 * Testable variant of {@link launch}: runs the program against its layers and
 * yields structured exit information instead of calling `process.exit`. A
 * `ConfigLoadError` maps to `ConfigInvalid` carrying every issue found. No OS
 * signal is ever observed; inject one through `options.signal`. Interrupting
 * the returned effect drains the coordinator like a signal would.
 */
export const runToCompletion = <E, R, LE>(
  program: Effect.Effect<void, E, R>,
  layers: Layer.Layer<R, LE>,
  options?: RunOptions,
): Effect.Effect<RunOutcome> =>
  withShutdown(program, options?.signal).pipe(
    Effect.provide(layers),
    Effect.exit,
    Effect.map((exit): RunOutcome => {
      if (Exit.isSuccess(exit) || Cause.isInterruptedOnly(exit.cause)) return { _tag: "Success" };
      const failure = Cause.failureOption(exit.cause);
      if (Option.isSome(failure) && isConfigLoadError(failure.value)) {
        return { _tag: "ConfigInvalid", issues: failure.value.issues };
      }
      return { _tag: "Failed", cause: exit.cause };
    }),
  );
