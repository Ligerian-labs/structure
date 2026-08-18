import { Command, HelpDoc, ValidationError } from "@effect/cli";
import { BunContext, BunRuntime } from "@effect/platform-bun";
import { ConfigLoadError } from "@structure-ai/config";
import { Cause, Effect, Exit, Option } from "effect";

/** The command succeeded. */
export const EXIT_SUCCESS = 0;
/** Permanent or conflict failure: retrying the same invocation cannot help. */
export const EXIT_FAILURE = 1;
/** Command line usage error (EX_USAGE). */
export const EXIT_USAGE = 64;
/** Unexpected defect — a bug, not an anticipated failure (EX_SOFTWARE). */
export const EXIT_SOFTWARE = 70;
/** Transient failure: the same invocation may succeed later (EX_TEMPFAIL). */
export const EXIT_TEMPFAIL = 75;
/** Configuration is missing or invalid (EX_CONFIG). */
export const EXIT_CONFIG = 78;
/** The command was interrupted (128 + SIGINT). */
export const EXIT_INTERRUPTED = 130;

type FailureClass = "transient" | "permanent" | "conflict";

const classificationOf = (error: unknown): FailureClass | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as { readonly classification?: unknown }).classification;
  return value === "transient" || value === "permanent" || value === "conflict" ? value : undefined;
};

const isConfigLoadError = (error: unknown): error is ConfigLoadError =>
  error instanceof ConfigLoadError ||
  (typeof error === "object" &&
    error !== null &&
    (error as { readonly _tag?: unknown })._tag === "ConfigLoadError");

const exitCodeForFailure = (error: unknown): number => {
  if (isConfigLoadError(error)) return EXIT_CONFIG;
  if (ValidationError.isValidationError(error)) return EXIT_USAGE;
  return classificationOf(error) === "transient" ? EXIT_TEMPFAIL : EXIT_FAILURE;
};

/**
 * Deterministic exit code for a failed command. Accepts either a plain error
 * or a `Cause`:
 *
 * - `ConfigLoadError` → 78 (EX_CONFIG)
 * - `@effect/cli` usage/parse errors → 64 (EX_USAGE)
 * - errors with `classification: "transient"` → 75 (EX_TEMPFAIL)
 * - errors with `classification: "permanent" | "conflict"` and every other
 *   typed failure → 1
 * - defects (untyped throws) → 70 (EX_SOFTWARE)
 * - pure interruption → 130
 */
export const exitCodeFor = (input: unknown): number => {
  if (Cause.isCause(input)) {
    if (Cause.isEmpty(input)) return EXIT_SUCCESS;
    const failure = Cause.failureOption(input);
    if (Option.isSome(failure)) return exitCodeForFailure(failure.value);
    return Cause.isInterruptedOnly(input) ? EXIT_INTERRUPTED : EXIT_SOFTWARE;
  }
  return exitCodeForFailure(input);
};

const failureMessage = (error: unknown): string => {
  if (isConfigLoadError(error)) return error.message;
  if (ValidationError.isValidationError(error)) return HelpDoc.toAnsiText(error.error).trimEnd();
  if (error instanceof Error) return error.message;
  return String(error);
};

const messageForCause = (cause: Cause.Cause<unknown>): string | undefined => {
  if (Cause.isEmpty(cause)) return undefined;
  const failure = Cause.failureOption(cause);
  if (Option.isSome(failure)) return failureMessage(failure.value);
  return Cause.pretty(cause);
};

/** Configuration for {@link runCli}. */
export interface RunCliOptions<Name extends string, E, A> {
  /** Executable name shown in help output. */
  readonly name: string;
  /** Version shown by the built-in `--version`. */
  readonly version: string;
  /** The root command (with any subcommands already attached). */
  readonly root: Command.Command<Name, BunContext.BunContext, E, A>;
  /** Prefix for error lines on stderr. Defaults to `name`. */
  readonly serviceName?: string;
}

/**
 * Production entrypoint: parses `process.argv`, runs the root command with
 * the Bun platform services provided, and exits with a classified,
 * deterministic exit code (see {@link exitCodeFor}).
 *
 * Usage/parse errors and `--help`/`--version` are reported by `@effect/cli`
 * itself; a `ConfigLoadError` prints its full issue list to stderr and exits
 * 78; other failures print one line to stderr; defects print the pretty
 * cause and exit 70.
 *
 * @example
 * ```ts
 * runCli({ name: "myapp", version: "1.2.3", root });
 * ```
 */
export const runCli = <Name extends string, E, A>(options: RunCliOptions<Name, E, A>): void => {
  const prefix = options.serviceName ?? options.name;
  const execute = Command.run(options.root, { name: options.name, version: options.version });
  const app = execute(process.argv).pipe(
    Effect.tapErrorCause((cause) =>
      Effect.sync(() => {
        const failure = Cause.failureOption(cause);
        if (Option.isSome(failure) && ValidationError.isValidationError(failure.value)) {
          return; // @effect/cli already printed the usage error
        }
        const message = messageForCause(cause);
        if (message !== undefined) {
          process.stderr.write(`${prefix}: ${message}\n`);
        }
      }),
    ),
    Effect.provide(BunContext.layer),
  );
  BunRuntime.runMain(app, {
    disableErrorReporting: true,
    disablePrettyLogger: true,
    teardown: (exit, onExit) => {
      onExit(Exit.isFailure(exit) ? exitCodeFor(exit.cause) : EXIT_SUCCESS);
    },
  });
};

/** Outcome of {@link runCliForTest}: what {@link runCli} would have done. */
export interface CliTestOutcome {
  /** The exit code {@link runCli} would have used. */
  readonly exitCode: number;
  /** The failure message {@link runCli} would have printed, if any. */
  readonly errorMessage: string | undefined;
  /** The full failure cause, for structural assertions. */
  readonly cause: Cause.Cause<unknown> | undefined;
}

/**
 * Testable variant of {@link runCli}: runs the command against the given
 * argv (flags and positionals only — no runtime/script prefix) and returns
 * the mapped exit code and error message instead of touching `process.exit`.
 * Note that `@effect/cli` still prints its own usage/help output to the
 * console.
 */
export const runCliForTest = <Name extends string, E, A>(
  root: Command.Command<Name, BunContext.BunContext, E, A>,
  argv: ReadonlyArray<string>,
  options?: { readonly name?: string; readonly version?: string },
): Effect.Effect<CliTestOutcome> => {
  const execute = Command.run(root, {
    name: options?.name ?? "test",
    version: options?.version ?? "0.0.0-test",
  });
  // `Command.run` expects a full argv whose first two entries are the
  // runtime and script paths; it drops them before parsing.
  return execute(["bun", "cli-test", ...argv]).pipe(
    Effect.matchCause({
      onFailure: (cause): CliTestOutcome => ({
        exitCode: exitCodeFor(cause),
        errorMessage: messageForCause(cause),
        cause,
      }),
      onSuccess: (): CliTestOutcome => ({
        exitCode: EXIT_SUCCESS,
        errorMessage: undefined,
        cause: undefined,
      }),
    }),
    Effect.provide(BunContext.layer),
  );
};
