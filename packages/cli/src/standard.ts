import { Options } from "@effect/cli";
import type { LoadOptions } from "@structure-ai/config";
import { layer as observabilityLayer, type ServiceMeta } from "@structure-ai/observability";
import { FiberRef, type Layer, type LogLevel, Option } from "effect";

/** Accepted values for `--log-format`. */
export type LogFormat = "json" | "pretty";

/**
 * `--log-level <all|trace|debug|info|warning|error|fatal|none>`: minimum log
 * level as a `LogLevel.LogLevel`. Defaults to `info`.
 *
 * `@effect/cli` ships `--log-level` as a *built-in* option: built-ins are
 * parsed before user-defined options, so a user-defined `--log-level` flag is
 * never reached. The built-in strips the flag from argv, validates the value
 * (invalid values are a usage error), and re-runs the command wrapped in
 * `Logger.withMinimumLogLevel(level)`. This option therefore declares no flag
 * of its own — it reads the ambient minimum log level the built-in set
 * (`FiberRef.currentMinimumLogLevel`, default `info`), so handlers still get
 * the parsed `LogLevel` as a plain typed value.
 */
export const logLevel: Options.Options<LogLevel.LogLevel> = Options.none.pipe(
  Options.mapEffect(() => FiberRef.get(FiberRef.currentMinimumLogLevel)),
);

/** `--log-format json|pretty`: log output format. Defaults to `json`. */
export const logFormat: Options.Options<LogFormat> = Options.choice("log-format", [
  "json",
  "pretty",
]).pipe(Options.withDescription("log output format (default: json)"), Options.withDefault("json"));

/** `--config-file <path>`: optional path to a JSON config file. */
export const configFile: Options.Options<Option.Option<string>> = Options.file("config-file").pipe(
  Options.withDescription("path to a JSON configuration file"),
  Options.optional,
);

/**
 * The standard global options every app gets, as a record ready to spread
 * into a command's `options`:
 *
 * @example
 * ```ts
 * const serve = defineCommand({
 *   name: "serve",
 *   options: { ...standardOptions, port: Options.integer("port") },
 *   handler: ({ port, ...standard }) =>
 *     Effect.gen(function* () {
 *       const { observability, loadOptions } = standardLayers(standard, "my-service");
 *       // load app config with loadOptions, provide observability
 *     }),
 * });
 * ```
 */
export const standardOptions = {
  logLevel,
  logFormat,
  configFile,
};

/** Parsed values of {@link standardOptions}. */
export interface StandardValues {
  readonly logLevel: LogLevel.LogLevel;
  readonly logFormat: LogFormat;
  readonly configFile: Option.Option<string>;
}

/**
 * {@link standardOptions} as a single composed `Options` value, for use with
 * raw `@effect/cli` where one `Options<StandardValues>` is more convenient
 * than a record.
 */
export const allStandardOptions: Options.Options<StandardValues> = Options.all(standardOptions);

/** Identity of the running service, used to tag telemetry. */
export interface ServiceIdentity {
  readonly name: string;
  readonly version?: string;
  readonly instance?: string;
}

/** What {@link standardLayers} yields: pre-wired framework plumbing. */
export interface StandardWiring {
  /** Full observability stack (logger, minimum level, service identity). */
  readonly observability: Layer.Layer<ServiceMeta>;
  /** Thread into `@structure-ai/config` `load`/`toLayer` so `--config-file` takes effect. */
  readonly loadOptions: LoadOptions;
}

/**
 * Turns parsed {@link standardOptions} values plus a service identity into
 * the framework layers: an `Observability.layer` honoring `--log-level` and
 * `--log-format`, and the config `LoadOptions` carrying `--config-file`.
 */
export const standardLayers = (
  values: StandardValues,
  service: string | ServiceIdentity,
): StandardWiring => {
  const identity = typeof service === "string" ? { name: service } : service;
  return {
    observability: observabilityLayer({
      service: identity,
      logLevel: values.logLevel,
      logFormat: values.logFormat,
    }),
    loadOptions: Option.match(values.configFile, {
      onNone: (): LoadOptions => ({}),
      onSome: (path): LoadOptions => ({ configFile: path }),
    }),
  };
};
