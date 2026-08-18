import { Runtime } from "@effect/platform";
import { BunRuntime } from "@effect/platform-bun";
import { type ConfigIssue, ConfigLoadError } from "@structure-ai/config";
import { Cause, Duration, Effect, Exit, type Layer, Option } from "effect";

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

/**
 * Production entrypoint wrapper around `BunRuntime.runMain`.
 *
 * Startup order comes from the layers: config loads and validates first, so a
 * `ConfigLoadError` is reported (every issue, via `Effect.logFatal`) and the
 * process exits with code 1 before any work is accepted. On shutdown the
 * runtime drains finalizers, bounded by `gracePeriod`, and exits
 * deterministically.
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
  const app = program.pipe(
    Effect.onExit(() => armDrainDeadline),
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
    teardown: (exit, onExit) => {
      if (configFailed) {
        onExit(1);
        return;
      }
      Runtime.defaultTeardown(exit, onExit);
    },
  });
};

/** Exit information from {@link runToCompletion}. */
export type RunOutcome =
  | { readonly _tag: "Success" }
  | { readonly _tag: "ConfigInvalid"; readonly issues: ReadonlyArray<ConfigIssue> }
  | { readonly _tag: "Failed"; readonly cause: Cause.Cause<unknown> };

/**
 * Testable variant of {@link launch}: runs the program against its layers and
 * yields structured exit information instead of calling `process.exit`. A
 * `ConfigLoadError` maps to `ConfigInvalid` carrying every issue found.
 */
export const runToCompletion = <E, R, LE>(
  program: Effect.Effect<void, E, R>,
  layers: Layer.Layer<R, LE>,
): Effect.Effect<RunOutcome> =>
  program.pipe(
    Effect.provide(layers),
    Effect.exit,
    Effect.map((exit): RunOutcome => {
      if (Exit.isSuccess(exit)) return { _tag: "Success" };
      const failure = Cause.failureOption(exit.cause);
      if (Option.isSome(failure) && isConfigLoadError(failure.value)) {
        return { _tag: "ConfigInvalid", issues: failure.value.issues };
      }
      return { _tag: "Failed", cause: exit.cause };
    }),
  );
