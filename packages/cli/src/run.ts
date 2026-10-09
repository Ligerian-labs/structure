import { writeSync } from "node:fs";
import { Command, HelpDoc, ValidationError } from "@effect/cli";
import { BunContext, BunRuntime } from "@effect/platform-bun";
import { ConfigLoadError } from "@structure-ai/config";
import { Cause, Console as ConsoleService, Effect, Exit, type Layer, Option } from "effect";
import type { Console as ConsoleInterface } from "effect/Console";

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
  error instanceof ConfigLoadError;

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
 * - any interruption → 130
 */
export const exitCodeFor = (input: unknown): number => {
  if (Cause.isCause(input)) {
    if (Cause.isEmpty(input)) return EXIT_SUCCESS;
    if (Cause.isInterrupted(input)) return EXIT_INTERRUPTED;
    if (Cause.defects(input).length > 0) return EXIT_SOFTWARE;
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
  if (Cause.isFailType(cause)) return failureMessage(cause.error);
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
 * Writes `data` to `fd` with blocking `writeSync` until every byte is out.
 *
 * Bun makes piped stdout/stderr non-blocking and silently drops whatever is
 * still queued on the async write path when the process exits, so CLI output
 * must not rely on `stream.write`/`console.log`. `EAGAIN` (pipe full) waits
 * briefly and retries so a slow reader is awaited rather than spun on;
 * `EPIPE` (reader gone, e.g. `| head -1`) is a normal end of output, not a
 * failure.
 */
const writeBlocking = (fd: number, data: Uint8Array): void => {
  let offset = 0;
  while (offset < data.length) {
    let written: number;
    try {
      written = writeSync(fd, data, offset, data.length - offset);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") {
        Bun.sleepSync(1);
        continue;
      }
      if (code === "EPIPE") return;
      throw error;
    }
    offset += written;
  }
};

/**
 * A stream that looks like `process.stdout`/`process.stderr` (TTY metadata,
 * everything else inherited) but turns every `write` into a blocking
 * {@link writeBlocking} call, so a `console.Console` built on top of it
 * cannot lose bytes to a full pipe.
 */
const blockingStream = (fd: number, target: NodeJS.WriteStream): NodeJS.WriteStream => {
  const stream = Object.create(target) as NodeJS.WriteStream;
  Object.defineProperty(stream, "write", {
    value: (
      chunk: string | Uint8Array,
      encodingOrCallback?: unknown,
      callback?: () => void,
    ): boolean => {
      const done =
        typeof encodingOrCallback === "function" ? (encodingOrCallback as () => void) : callback;
      writeBlocking(fd, typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
      if (typeof done === "function") done();
      return true;
    },
  });
  return stream;
};

/** The `console.Console` method surface {@link blockingConsole} relies on. */
interface ConsoleSink {
  assert(condition: boolean, ...data: ReadonlyArray<unknown>): void;
  clear(): void;
  count(label?: string): void;
  countReset(label?: string): void;
  debug(...data: ReadonlyArray<unknown>): void;
  dir(item: unknown, options?: unknown): void;
  dirxml(...data: ReadonlyArray<unknown>): void;
  error(...data: ReadonlyArray<unknown>): void;
  group(...data: ReadonlyArray<unknown>): void;
  groupCollapsed(...data: ReadonlyArray<unknown>): void;
  groupEnd(): void;
  info(...data: ReadonlyArray<unknown>): void;
  log(...data: ReadonlyArray<unknown>): void;
  table(tabularData: unknown, properties?: ReadonlyArray<string>): void;
  time(label?: string): void;
  timeEnd(label?: string): void;
  timeLog(label?: string, ...data: ReadonlyArray<unknown>): void;
  trace(...data: ReadonlyArray<unknown>): void;
  warn(...data: ReadonlyArray<unknown>): void;
}

/**
 * `bun-types` leaves `console.Console` untyped; the constructor exists at
 * runtime on Bun (verified) and its formatting matches the global console
 * exactly, which is why it is preferred over re-implementing `util.format`
 * semantics. Single confined cast.
 */
const makeConsoleSink = (): ConsoleSink =>
  new (
    console as {
      readonly Console: new (options: {
        readonly stdout: NodeJS.WriteStream;
        readonly stderr: NodeJS.WriteStream;
      }) => ConsoleSink;
    }
  ).Console({
    stdout: blockingStream(1, process.stdout),
    stderr: blockingStream(2, process.stderr),
  });

const sink = makeConsoleSink();

/**
 * Installs the blocking sink as the global `console` and returns the
 * previous console. Handler code writes output with the plain `console.log`
 * of the host (that is exactly how issue #101 reproduced), and that global
 * does not go through the Effect `Console` service — so the service alone
 * cannot make the process lossless. The swap is process-wide by design:
 * `runCli` owns the process lifecycle (single entrypoint, exit code, output)
 * and runs before any handler code can capture the old reference.
 */
const installGlobalSink = (): void => {
  globalThis.console = sink as unknown as typeof globalThis.console;
};

/**
 * `Console` service whose writes block until the bytes reach the OS. On Bun
 * the async write path backs up when stdout is a pipe and is dropped at
 * process exit, truncating command output (issue #101). Every consumer in a
 * `runCli` process routes through this service — command handlers'
 * `Console.log`, `@effect/cli`'s own help/version/completions output, and
 * Effect's default loggers — so backing it with blocking writes makes the
 * whole process lossless without touching each call site.
 */
const blockingConsole: ConsoleInterface = {
  [ConsoleService.TypeId]: ConsoleService.TypeId,
  assert: (...data) => Effect.sync(() => sink.assert(...data)),
  clear: Effect.sync(() => sink.clear()),
  count: (label) => Effect.sync(() => sink.count(label)),
  countReset: (label) => Effect.sync(() => sink.countReset(label)),
  debug: (...data) => Effect.sync(() => sink.debug(...data)),
  dir: (item, options) => Effect.sync(() => sink.dir(item, options)),
  dirxml: (...data) => Effect.sync(() => sink.dirxml(...data)),
  error: (...data) => Effect.sync(() => sink.error(...data)),
  group: (options) =>
    Effect.sync(() => {
      if (options?.collapsed === true) {
        sink.groupCollapsed(options.label);
        return;
      }
      sink.group(options?.label);
    }),
  groupEnd: Effect.sync(() => sink.groupEnd()),
  info: (...data) => Effect.sync(() => sink.info(...data)),
  log: (...data) => Effect.sync(() => sink.log(...data)),
  table: (tabularData, properties) => Effect.sync(() => sink.table(tabularData, properties)),
  time: (label) => Effect.sync(() => sink.time(label)),
  timeEnd: (label) => Effect.sync(() => sink.timeEnd(label)),
  timeLog: (label, ...data) => Effect.sync(() => sink.timeLog(label, ...data)),
  trace: (...data) => Effect.sync(() => sink.trace(...data)),
  warn: (...data) => Effect.sync(() => sink.warn(...data)),
  unsafe: sink,
};

/**
 * Provides the blocking {@link ConsoleService} for a Bun CLI process. Used
 * by {@link runCli}; exported for entrypoints that run commands outside
 * `runCli` (custom runtimes) and for tests.
 */
export const layerBlockingConsole: Layer.Layer<never> = ConsoleService.setConsole(blockingConsole);

/**
 * Production entrypoint: parses `process.argv`, runs the root command with
 * the Bun platform services provided, and exits with a classified,
 * deterministic exit code (see {@link exitCodeFor}).
 *
 * All output — handler `Console.log` calls, `@effect/cli` help/version
 * output, error lines — goes through the blocking console (see
 * {@link layerBlockingConsole}) so nothing is lost when stdout is a pipe:
 * by the time the process exits, every byte has reached the OS.
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
  installGlobalSink();
  const execute = Command.run(options.root, { name: options.name, version: options.version });
  const app = execute(process.argv).pipe(
    Effect.tapErrorCause((cause) =>
      Effect.sync(() => {
        const failure = Cause.failureOption(cause);
        if (
          Cause.isFailType(cause) &&
          Option.isSome(failure) &&
          ValidationError.isValidationError(failure.value)
        ) {
          return; // @effect/cli already printed the usage error
        }
        const message = messageForCause(cause);
        if (message !== undefined) {
          writeBlocking(2, Buffer.from(`${prefix}: ${message}\n`, "utf8"));
        }
      }),
    ),
    Effect.provide(BunContext.layer),
    Effect.provide(layerBlockingConsole),
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
