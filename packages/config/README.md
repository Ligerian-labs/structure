# @structure-ai/config

Typed environment + configuration management on Effect `Config`. Settings are defined once and yield both a validated, immutable config value and a rendered settings reference. Startup validation reports **all** issues together, then fails before the process accepts work.

Precedence (highest wins): explicit overrides → environment variables → JSON config file → dotenv file → code defaults.

## Usage

```ts
import { load, Settings, toLayer } from "@structure-ai/config";
import { Context, Duration, Effect } from "effect";

const settings = Settings.struct({
  host: Settings.string("HOST", { default: "0.0.0.0" }),
  port: Settings.port("PORT", { description: "listen port" }),
  timeout: Settings.duration("TIMEOUT", { default: Duration.seconds(5) }),
  apiKey: Settings.secret("API_KEY"),
  otlpUrl: Settings.optional(Settings.url("OTLP_URL")),
});

const program = Effect.gen(function* () {
  const config = yield* load(settings, { dotEnvFile: ".env" });
  // config.port: number, config.apiKey: Redacted<string>, config.otlpUrl: Option<URL>
});

// Or as a layer: toLayer(SomeTag, settings, { configFile: "config.json" })
// Docs table for operators: Settings.renderDocs(settings)
```

## Load options

| Option | Effect |
| --- | --- |
| `overrides` | Explicit values (e.g. parsed CLI flags). Highest precedence. |
| `env` | Environment map used instead of `process.env` (same `_` nesting delimiter: `HTTP_PORT`). Lets tests and CLIs load from a controlled map without mutating the process environment. |
| `blankMeansUnset` | Default `true`: environment entries that are empty or whitespace-only count as unset, so `PORT=` falls back to the default and `optional` loads `None`. Applies to `env` and `process.env`, not to `overrides`, the config file, or the dotenv file. Set `false` to keep a literal empty string as a present value (an `int` then fails validation, an `optional` string loads `Some("")`). |
| `configFile` | Versioned non-secret JSON file, below environment variables. |
| `dotEnvFile` | Dotenv file below the config file. Opt-in, for local development. |

`docker compose` forwards an unset operator variable declared as `VAR=${VAR:-}` as `VAR=` (empty string); with the default `blankMeansUnset` that reaches settings as absent instead of `Number("") === 0` or `Some("")`.

```ts
// Production-shaped loading from a controlled map (no process.env mutation):
const config = yield* load(settings, { env: { PORT: "8080", API_KEY: "s3cret" } });
```

## Exports

| Export | What it is |
| --- | --- |
| `Settings.string/int/number/boolean/port/url/duration/logLevel/literal/secret` | Leaf setting combinators carrying doc metadata. |
| `Settings.optional(setting)` | Absent → `Option.none()` instead of an error. |
| `Settings.struct(fields)` / `Settings.nested(prefix, setting)` | Composition; nesting prefixes env names (`HTTP_PORT`). |
| `Settings.renderDocs(setting)` | Markdown table: name, type, required, default, secret, description. |
| `load(setting, options?)` | Effect loading + validating; fails with `ConfigLoadError`. Options: `overrides`, `env`, `blankMeansUnset`, `configFile`, `dotEnvFile`. |
| `toLayer(tag, setting, options?)` | The same as a `Layer`. |
| `withTestConfig(values)(effect)` | Runs an effect against a fixed value map (tests). `load(setting, { env })` is the production-shaped counterpart. |
| `ConfigLoadError` | Tagged error with `issues: ConfigIssue[]`, one per problem. |
| `parseDotEnv(content)` | Minimal dotenv parser (used by `dotEnvFile`). |

Secrets (`Settings.secret`) load as `Redacted<string>` and never render in logs or errors.
