import { Args, Command, Options } from "@effect/cli";
import type { Effect } from "effect";
import type * as Types from "effect/Types";

/**
 * Stable re-exports of the underlying `@effect/cli` modules. Apps declare
 * their flags and positional arguments with these and never need a direct
 * dependency on `@effect/cli`.
 *
 * @example
 * ```ts
 * import { Args, Options } from "@structure/cli";
 * import { Schema } from "effect";
 *
 * const count = Options.integer("count").pipe(Options.withDefault(1));
 * const format = Options.choice("format", ["json", "text"]);
 * const port = Options.text("port").pipe(
 *   Options.withSchema(Schema.NumberFromString.pipe(Schema.int(), Schema.between(1, 65535))),
 * );
 * const input = Args.file({ name: "input" });
 * ```
 */
export { Args, Command, Options };

/**
 * Declarative input for {@link defineCommand}. `options` and `args` are plain
 * records of `Options`/`Args`; the handler receives one merged record of the
 * parsed values, fully typed.
 */
export interface CommandDefinition<
  Name extends string,
  Opts extends Command.Command.Config,
  Positional extends Command.Command.Config,
  E,
  R,
> {
  readonly name: Name;
  /** Shown in `--help` output. */
  readonly description?: string;
  /** Named flags (`--count 3`). Keys become the handler input keys. */
  readonly options?: Opts;
  /** Positional arguments, in declaration order. */
  readonly args?: Positional;
  readonly handler: (
    input: Types.Simplify<Command.Command.ParseConfig<Opts & Positional>>,
  ) => Effect.Effect<void, E, R>;
}

/**
 * Thin sugar over `Command.make` that separates options from positional
 * arguments and attaches the description in one literal, with full type
 * inference preserved: the handler input type is derived from the declared
 * `options`/`args`.
 *
 * Drop down to raw `@effect/cli` (`Command.make`, `Command.prompt`,
 * `Command.transformHandler`, ...) when you need nested option groups,
 * interactive prompts, or per-command layers via `Command.provide`.
 *
 * @example
 * ```ts
 * import { defineCommand, Options, Args } from "@structure/cli";
 * import { Effect } from "effect";
 *
 * const greet = defineCommand({
 *   name: "greet",
 *   description: "Print a greeting",
 *   options: { count: Options.integer("count").pipe(Options.withDefault(1)) },
 *   args: { who: Args.text({ name: "who" }) },
 *   handler: ({ count, who }) => Effect.log(`hello ${who} x${count}`),
 * });
 * ```
 */
export const defineCommand = <
  Name extends string,
  const Opts extends Command.Command.Config = Record<never, never>,
  const Positional extends Command.Command.Config = Record<never, never>,
  E = never,
  R = never,
>(
  definition: CommandDefinition<Name, Opts, Positional, E, R>,
): Command.Command<Name, R, E, Types.Simplify<Command.Command.ParseConfig<Opts & Positional>>> => {
  const config = {
    ...(definition.options ?? ({} as Opts)),
    ...(definition.args ?? ({} as Positional)),
  } as Opts & Positional;
  const command = Command.make(definition.name, config, definition.handler);
  return definition.description === undefined
    ? command
    : Command.withDescription(command, definition.description);
};

/**
 * Attaches subcommands to a parent command. Pure passthrough to
 * `Command.withSubcommands`; when a subcommand matches, its handler runs —
 * otherwise the parent handler runs with `subcommand: Option.none()` in its
 * input.
 *
 * @example
 * ```ts
 * const root = withSubcommands(defineCommand({ name: "app", handler: () => Effect.void }), [
 *   greet,
 * ]);
 * ```
 */
export const withSubcommands: typeof Command.withSubcommands = Command.withSubcommands;
