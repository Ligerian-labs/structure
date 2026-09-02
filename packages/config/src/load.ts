import { readFileSync } from "node:fs";
import type { Config, Context } from "effect";
import { ConfigProvider, Effect, Layer } from "effect";
import { ConfigLoadError, flattenConfigError } from "./errors.js";
import type { Setting } from "./Settings.js";

/**
 * Sources for configuration values, applied with this precedence
 * (highest wins): explicit overrides → environment variables (`env` when
 * given, else `process.env`) → config file (JSON) → dotenv file → code defaults.
 */
export interface LoadOptions {
  /** Explicit runtime overrides (e.g. parsed CLI flags). Highest precedence. */
  readonly overrides?: Readonly<Record<string, string>>;
  /** Path to a versioned non-secret JSON config file. */
  readonly configFile?: string;
  /** Path to a dotenv file loaded below real environment variables. Opt-in, for local development. */
  readonly dotEnvFile?: string;
  /**
   * Environment map used as the environment-variable source instead of
   * `process.env` (same `_` nesting delimiter). Lets tests and CLIs load from
   * a controlled map without mutating the process environment.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * When `true` (default), environment entries whose value is empty or
   * whitespace-only are treated as unset, so `VAR=` (as forwarded by
   * `docker compose` for an unset operator variable) falls back to the
   * setting's default and `optional` loads `None`. Set to `false` to keep a
   * literal empty string as a present value.
   */
  readonly blankMeansUnset?: boolean;
}

const processEnv = (): Readonly<Record<string, string | undefined>> =>
  typeof process === "undefined" ? {} : process.env;

const environmentMap = (
  source: Readonly<Record<string, string | undefined>>,
  blankMeansUnset: boolean,
): Map<string, string> => {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (blankMeansUnset && value.trim() === "") continue;
    out.set(key, value);
  }
  return out;
};

const environmentProvider = (options: LoadOptions): ConfigProvider.ConfigProvider =>
  ConfigProvider.fromMap(
    environmentMap(options.env ?? processEnv(), options.blankMeansUnset ?? true),
    { pathDelim: "_" },
  );

const readFile = (path: string): Effect.Effect<string, ConfigLoadError> =>
  Effect.try({
    try: () => readFileSync(path, "utf8"),
    catch: (cause) =>
      new ConfigLoadError({
        issues: [{ kind: "source", path, reason: `cannot read file: ${String(cause)}` }],
      }),
  });

/** Minimal dotenv parser: KEY=value lines, `#` comments, optional single/double quotes. */
export const parseDotEnv = (content: string): Map<string, string> => {
  const out = new Map<string, string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line
      .slice(0, eq)
      .trim()
      .replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key !== "") out.set(key, value);
  }
  return out;
};

const buildProvider = (
  options: LoadOptions,
): Effect.Effect<ConfigProvider.ConfigProvider, ConfigLoadError> =>
  Effect.gen(function* () {
    const providers: Array<ConfigProvider.ConfigProvider> = [];
    if (options.overrides !== undefined) {
      providers.push(
        ConfigProvider.fromMap(new Map(Object.entries(options.overrides)), { pathDelim: "_" }),
      );
    }
    providers.push(environmentProvider(options));
    if (options.configFile !== undefined) {
      const content = yield* readFile(options.configFile);
      const json = yield* Effect.try({
        try: () => JSON.parse(content) as unknown,
        catch: (cause) =>
          new ConfigLoadError({
            issues: [
              {
                kind: "invalid",
                path: options.configFile ?? "",
                reason: `invalid JSON: ${String(cause)}`,
              },
            ],
          }),
      });
      providers.push(ConfigProvider.fromJson(json));
    }
    if (options.dotEnvFile !== undefined) {
      const content = yield* readFile(options.dotEnvFile);
      providers.push(ConfigProvider.fromMap(parseDotEnv(content), { pathDelim: "_" }));
    }
    const [first, ...rest] = providers;
    if (first === undefined) {
      return ConfigProvider.fromMap(new Map());
    }
    return rest.reduce((acc, next) => ConfigProvider.orElse(acc, () => next), first);
  });

/**
 * Loads and validates a setting definition into one typed, immutable value.
 * Fails with a `ConfigLoadError` carrying every issue found, so a process can
 * report all misconfiguration at startup and refuse to accept work.
 */
export const load = <A>(
  setting: Setting<A>,
  options: LoadOptions = {},
): Effect.Effect<A, ConfigLoadError> =>
  Effect.gen(function* () {
    const provider = yield* buildProvider(options);
    return yield* provider
      .load(setting.config)
      .pipe(Effect.mapError((error) => new ConfigLoadError({ issues: flattenConfigError(error) })));
  });

/** Provides a loaded configuration as a service layer. */
export const toLayer = <Self, A>(
  tag: Context.Tag<Self, A>,
  setting: Setting<A>,
  options: LoadOptions = {},
): Layer.Layer<Self, ConfigLoadError> => Layer.effect(tag, load(setting, options));

/** Runs an effect against a fixed map of values — for tests. */
export const withTestConfig =
  (values: Readonly<Record<string, string>>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.withConfigProvider(effect, ConfigProvider.fromMap(new Map(Object.entries(values))));

export type { Config };
