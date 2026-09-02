import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ConfigProvider, Effect, Layer } from "effect";
import * as Document from "./document.js";
import { DotenvError } from "./errors.js";
import { type Expandable, expand } from "./expand.js";

export interface LoadOptions {
  /** Directory the file names resolve against. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  /**
   * Explicit files to load, lowest precedence first; each must exist.
   * When omitted the environment cascade is used: `.env`, `.env.local`,
   * `.env.<environment>`, `.env.<environment>.local` (later files win,
   * missing ones are skipped, and `.env.local` is skipped when the
   * environment is `test` so tests stay reproducible).
   */
  readonly files?: ReadonlyArray<string>;
  /**
   * Name driving the cascade. Defaults to `NODE_ENV` from `env`; an empty
   * string loads only `.env` and `.env.local`.
   */
  readonly environment?: string;
  /** The process environment. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * `false` (default): a variable already present in `env` keeps its value
   * and the file's value is reported as shadowed — the classic dotenv rule,
   * which also makes Bun's own `.env` preloading harmless. `true`: file
   * values win over the environment.
   */
  readonly override?: boolean;
  /** Expand `$VAR` references (default `true`). Single-quoted values are always literal. */
  readonly expand?: boolean;
}

export interface Loaded {
  /** The variables the files contribute, after precedence against `env`. */
  readonly values: ReadonlyMap<string, string>;
  /** Absolute paths of the files that were read, lowest precedence first. */
  readonly files: ReadonlyArray<string>;
  /** Keys defined in the files but kept from `env` because `override` is off. */
  readonly shadowed: ReadonlyArray<string>;
  /** For every key the files define, the file whose value took effect. */
  readonly sources: ReadonlyMap<string, string>;
}

const processEnv = (): Readonly<Record<string, string | undefined>> =>
  typeof process === "undefined" ? {} : process.env;

/** The conventional file list for an environment name, lowest precedence first. */
export const cascade = (environment: string): ReadonlyArray<string> => [
  ".env",
  ...(environment === "test" ? [] : [".env.local"]),
  ...(environment === "" ? [] : [`.env.${environment}`, `.env.${environment}.local`]),
];

const readFile = (path: string): Effect.Effect<string, DotenvError> =>
  Effect.try({
    try: () => readFileSync(path, "utf8"),
    catch: (cause) =>
      new DotenvError({ kind: "read", path, reason: `cannot read file: ${String(cause)}` }),
  });

interface Selected {
  readonly path: string;
  readonly required: boolean;
}

const selectFiles = (options: LoadOptions, env: LoadOptions["env"]): ReadonlyArray<Selected> => {
  const cwd = options.cwd ?? process.cwd();
  if (options.files !== undefined) {
    return options.files.map((file) => ({ path: resolve(cwd, file), required: true }));
  }
  const environment = options.environment ?? env?.NODE_ENV ?? "";
  return cascade(environment).map((file) => ({ path: resolve(cwd, file), required: false }));
};

/**
 * Reads the dotenv files and computes the variables they contribute.
 * Nothing is written to `process.env`; see {@link apply} for that, or
 * {@link environment} / {@link configProvider} to feed the result to
 * `@structure-ai/config` and Effect `Config` without global mutation.
 */
export const load = (options: LoadOptions = {}): Effect.Effect<Loaded, DotenvError> =>
  Effect.gen(function* () {
    const env = options.env ?? processEnv();
    const override = options.override ?? false;
    const files: Array<string> = [];
    const entries = new Map<string, Expandable & { readonly source: string }>();
    for (const selected of selectFiles(options, env)) {
      if (!existsSync(selected.path)) {
        if (selected.required) {
          return yield* new DotenvError({
            kind: "missing",
            path: selected.path,
            reason: "file not found",
          });
        }
        continue;
      }
      const content = yield* readFile(selected.path);
      files.push(selected.path);
      for (const item of Document.assignments(Document.parse(content))) {
        entries.set(item.key, {
          key: item.key,
          value: item.value,
          quote: item.quote,
          source: selected.path,
        });
      }
    }
    const list = [...entries.values()];
    const expanded =
      options.expand === false
        ? new Map(list.map((entry) => [entry.key, entry.value] as const))
        : yield* expand(list, { env, override });
    const values = new Map<string, string>();
    const shadowed: Array<string> = [];
    const sources = new Map<string, string>();
    for (const entry of list) {
      sources.set(entry.key, entry.source);
      if (!override && env[entry.key] !== undefined) {
        shadowed.push(entry.key);
        continue;
      }
      values.set(entry.key, expanded.get(entry.key) ?? "");
    }
    return { values, files, shadowed, sources };
  });

/**
 * The environment a process would see after loading: `env` (defined values
 * only) merged with the loaded values. Pass it to `@structure-ai/config`'s
 * `load(settings, { env })` to keep configuration loading free of global
 * state.
 */
export const environment = (
  options: LoadOptions = {},
): Effect.Effect<Record<string, string>, DotenvError> =>
  Effect.map(load(options), (loaded) => {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(options.env ?? processEnv())) {
      if (value !== undefined) out[key] = value;
    }
    for (const [key, value] of loaded.values) out[key] = value;
    return out;
  });

/** Loads the files and writes the resulting values into `process.env` — the classic dotenv behaviour. */
export const apply = (options: LoadOptions = {}): Effect.Effect<Loaded, DotenvError> =>
  Effect.tap(load(options), (loaded) =>
    Effect.sync(() => {
      for (const [key, value] of loaded.values) process.env[key] = value;
    }),
  );

/** {@link apply} as a layer, for the top of an application's layer stack. */
export const layer = (options: LoadOptions = {}): Layer.Layer<never, DotenvError> =>
  Layer.effectDiscard(apply(options));

/**
 * A `ConfigProvider` over {@link environment} with `_` as the nesting
 * delimiter, so `Config.nested` lookups work the way they do against real
 * environment variables. Use with `Effect.withConfigProvider` or
 * `Layer.setConfigProvider`.
 */
export const configProvider = (
  options: LoadOptions = {},
): Effect.Effect<ConfigProvider.ConfigProvider, DotenvError> =>
  Effect.map(environment(options), (env) =>
    ConfigProvider.fromMap(new Map(Object.entries(env)), { pathDelim: "_" }),
  );
