import { Config, type Duration, type LogLevel, type Option, type Redacted } from "effect";

/**
 * A setting couples an Effect `Config` with the metadata needed to document
 * it: name, type, default, sensitivity. Definitions built from these
 * combinators can always be rendered as a settings reference table.
 */
export interface Setting<out A> {
  readonly config: Config.Config<A>;
  readonly docs: ReadonlyArray<SettingDoc>;
}

export interface SettingDoc {
  readonly name: string;
  readonly type: string;
  readonly description: string;
  readonly defaultValue: string | undefined;
  readonly secret: boolean;
  readonly required: boolean;
}

export interface SettingOptions<A> {
  readonly description?: string;
  readonly default?: A;
}

const make = <A>(
  name: string,
  type: string,
  base: Config.Config<A>,
  options?: SettingOptions<A>,
  renderDefault: (a: A) => string = String,
  secret = false,
): Setting<A> => {
  const hasDefault = options !== undefined && "default" in options && options.default !== undefined;
  const config = hasDefault ? Config.withDefault(base, options.default as A) : base;
  return {
    config,
    docs: [
      {
        name,
        type,
        description: options?.description ?? "",
        defaultValue: hasDefault ? renderDefault(options.default as A) : undefined,
        secret,
        required: !hasDefault,
      },
    ],
  };
};

export const string = (name: string, options?: SettingOptions<string>): Setting<string> =>
  make(name, "string", Config.string(name), options);

export const int = (name: string, options?: SettingOptions<number>): Setting<number> =>
  make(name, "integer", Config.integer(name), options);

export const number = (name: string, options?: SettingOptions<number>): Setting<number> =>
  make(name, "number", Config.number(name), options);

export const boolean = (name: string, options?: SettingOptions<boolean>): Setting<boolean> =>
  make(name, "boolean", Config.boolean(name), options);

export const port = (name: string, options?: SettingOptions<number>): Setting<number> =>
  make(
    name,
    "port",
    Config.integer(name).pipe(
      Config.validate({
        message: "a port must be an integer between 1 and 65535",
        validation: (n) => Number.isInteger(n) && n >= 1 && n <= 65535,
      }),
    ),
    options,
  );

export const url = (name: string, options?: SettingOptions<URL>): Setting<URL> =>
  make(name, "url", Config.url(name), options, (u) => u.toString());

export const duration = (
  name: string,
  options?: SettingOptions<Duration.Duration>,
): Setting<Duration.Duration> =>
  make(name, "duration", Config.duration(name), options, (d) => String(d));

export const logLevel = (
  name: string,
  options?: SettingOptions<LogLevel.LogLevel>,
): Setting<LogLevel.LogLevel> =>
  make(name, "log-level", Config.logLevel(name), options, (l) => l.label);

export const literal = <const Literals extends ReadonlyArray<string>>(
  name: string,
  values: Literals,
  options?: SettingOptions<Literals[number]>,
): Setting<Literals[number]> =>
  make(name, values.map((v) => `"${v}"`).join(" | "), Config.literal(...values)(name), options);

/** A secret value. Never has a default; rendered redacted everywhere. */
export const secret = (
  name: string,
  options?: Pick<SettingOptions<never>, "description">,
): Setting<Redacted.Redacted<string>> =>
  make(name, "secret", Config.redacted(name), options, String, true);

/** Marks a setting as optional: absent values load as `Option.none()`. */
export const optional = <A>(setting: Setting<A>): Setting<Option.Option<A>> => ({
  config: Config.option(setting.config),
  docs: setting.docs.map((d) => ({ ...d, required: false })),
});

/**
 * Combines named settings into one typed, immutable configuration object.
 * The result is itself a `Setting`, so groups nest.
 */
export const struct = <Fields extends Record<string, Setting<unknown>>>(
  fields: Fields,
): Setting<{ readonly [K in keyof Fields]: Fields[K] extends Setting<infer A> ? A : never }> => {
  const configs: Record<string, Config.Config<unknown>> = {};
  const docs: Array<SettingDoc> = [];
  for (const [key, setting] of Object.entries(fields)) {
    configs[key] = setting.config;
    docs.push(...setting.docs);
  }
  return {
    config: Config.all(configs) as Config.Config<{
      readonly [K in keyof Fields]: Fields[K] extends Setting<infer A> ? A : never;
    }>,
    docs,
  };
};

/** Namespaces a setting: env lookup becomes `PREFIX_NAME`. */
export const nested = <A>(prefix: string, setting: Setting<A>): Setting<A> => ({
  config: Config.nested(setting.config, prefix),
  docs: setting.docs.map((d) => ({ ...d, name: `${prefix}_${d.name}` })),
});

/** Renders the settings reference as a markdown table. */
export const renderDocs = (setting: Setting<unknown>): string => {
  const header = "| Name | Type | Required | Default | Secret | Description |";
  const sep = "| --- | --- | --- | --- | --- | --- |";
  const rows = setting.docs.map(
    (d) =>
      `| ${d.name} | ${d.type} | ${d.required ? "yes" : "no"} | ${
        d.defaultValue ?? ""
      } | ${d.secret ? "yes" : ""} | ${d.description} |`,
  );
  return [header, sep, ...rows].join("\n");
};
