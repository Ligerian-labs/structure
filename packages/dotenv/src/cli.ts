import { resolve } from "node:path";
import { Args, defineCommand, Options, withSubcommands } from "@structure-ai/cli";
import { ConfigLoadError, type Setting } from "@structure-ai/config";
import { Console, Effect, Option } from "effect";
import { check, toConfigIssues } from "./check.js";
import { DotenvError } from "./errors.js";
import { environment, type LoadOptions, load } from "./load.js";
import { setValues, unsetKeys } from "./write.js";

export interface DotenvCommandOptions extends LoadOptions {
  /** The application's settings definition, for `check`. */
  readonly settings?: Setting<unknown>;
  /** Default example file for `check` (overridable with `--example`). */
  readonly example?: string;
}

const REDACTED = "<redacted>";

/**
 * Ready-made `dotenv` command group for a framework CLI:
 * - `<app> dotenv check [--example FILE] [--allow-empty]` reports missing,
 *   empty and undeclared variables and exits 78 (`ConfigLoadError`) when a
 *   required one is missing or empty;
 * - `<app> dotenv print [--reveal] [--json]` lists what the files
 *   contribute, values redacted unless `--reveal`, plus the keys the
 *   environment shadows;
 * - `<app> dotenv run -- <command...>` runs a command with the loaded
 *   environment; a non-zero child exit fails the command (exit 1) with the
 *   child's code in the message;
 * - `<app> dotenv set KEY VALUE [--file .env]` and
 *   `<app> dotenv unset KEY... [--file .env]` edit a file in place, keeping
 *   comments and ordering.
 *
 * `options` fix the cwd, files, environment name and override policy for
 * every subcommand.
 */
export const dotenvCommand = (options: DotenvCommandOptions = {}) => {
  const { settings, example, ...loadOptions } = options;
  const cwd = loadOptions.cwd ?? process.cwd();

  const checkCommand = defineCommand({
    name: "check",
    description: "Verify required variables are set (settings definition and/or example file)",
    options: {
      example: Options.file("example").pipe(Options.optional),
      allowEmpty: Options.boolean("allow-empty"),
    },
    handler: (input) =>
      Effect.gen(function* () {
        const exampleFile = Option.getOrElse(input.example, () => example);
        const report = yield* check({
          ...loadOptions,
          ...(settings === undefined ? {} : { settings }),
          ...(exampleFile === undefined ? {} : { example: exampleFile }),
          allowEmpty: input.allowEmpty,
        });
        for (const key of report.unknown) yield* Console.log(`unknown  ${key}`);
        for (const key of report.empty) yield* Console.log(`empty    ${key}`);
        for (const key of report.missing) yield* Console.log(`missing  ${key}`);
        yield* Console.log(
          `${report.required.length} required, ${report.missing.length} missing, ${report.empty.length} empty, ${report.unknown.length} unknown`,
        );
        const issues = toConfigIssues(report);
        if (issues.length > 0) return yield* new ConfigLoadError({ issues });
      }),
  });

  const printCommand = defineCommand({
    name: "print",
    description: "Show the variables the dotenv files contribute (values redacted unless --reveal)",
    options: {
      reveal: Options.boolean("reveal"),
      json: Options.boolean("json"),
    },
    handler: (input) =>
      Effect.gen(function* () {
        const loaded = yield* load(loadOptions);
        const show = (value: string): string => (input.reveal ? value : REDACTED);
        if (input.json) {
          const values: Record<string, string> = {};
          for (const [key, value] of loaded.values) values[key] = show(value);
          yield* Console.log(
            JSON.stringify({ files: loaded.files, values, shadowed: loaded.shadowed }, null, 2),
          );
          return;
        }
        for (const file of loaded.files) yield* Console.log(`# ${file}`);
        for (const [key, value] of loaded.values) {
          yield* Console.log(`${key}=${show(value)}`);
        }
        for (const key of loaded.shadowed) {
          yield* Console.log(`# ${key} kept from the environment`);
        }
      }),
  });

  const runCommand = defineCommand({
    name: "run",
    description: "Run a command with the loaded environment: dotenv run -- <command...>",
    args: { command: Args.text({ name: "command" }).pipe(Args.atLeast(1)) },
    handler: ({ command }) =>
      Effect.gen(function* () {
        const env = yield* environment(loadOptions);
        const exitCode = yield* Effect.tryPromise({
          try: () =>
            Bun.spawn(command, {
              cwd,
              env,
              stdin: "inherit",
              stdout: "inherit",
              stderr: "inherit",
            }).exited,
          catch: (cause) =>
            new DotenvError({
              kind: "run",
              reason: `cannot start ${command[0] ?? ""}: ${String(cause)}`,
            }),
        });
        if (exitCode !== 0) {
          return yield* new DotenvError({
            kind: "run",
            exitCode,
            reason: `${command[0] ?? ""} exited with code ${exitCode}`,
          });
        }
      }),
  });

  const fileOption = Options.file("file").pipe(Options.withDefault(".env"));

  const setCommand = defineCommand({
    name: "set",
    description: "Set a variable in a dotenv file, preserving comments and ordering",
    options: { file: fileOption },
    args: { key: Args.text({ name: "key" }), value: Args.text({ name: "value" }) },
    handler: ({ file, key, value }) =>
      setValues(resolve(cwd, file), { [key]: value }).pipe(
        Effect.tap(() => Console.log(`set ${key} in ${file}`)),
      ),
  });

  const unsetCommand = defineCommand({
    name: "unset",
    description: "Remove variables from a dotenv file",
    options: { file: fileOption },
    args: { keys: Args.text({ name: "key" }).pipe(Args.atLeast(1)) },
    handler: ({ file, keys }) =>
      unsetKeys(resolve(cwd, file), keys).pipe(
        Effect.tap(() => Console.log(`unset ${keys.join(", ")} in ${file}`)),
      ),
  });

  const root = defineCommand({
    name: "dotenv",
    description: "Inspect, verify, and edit .env files",
    handler: () => Console.log("use a subcommand: check | print | run | set | unset"),
  });

  return withSubcommands(root, [checkCommand, printCommand, runCommand, setCommand, unsetCommand]);
};
