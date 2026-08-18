# @structure/config

Typed environment + configuration management on Effect `Config`. Settings are defined once and yield both a validated, immutable config value and a rendered settings reference. Startup validation reports **all** issues together, then fails before the process accepts work.

Precedence (highest wins): explicit overrides → environment variables → JSON config file → dotenv file → code defaults.

## Usage

```ts
import { load, Settings, toLayer } from "@structure/config";
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

## Exports

| Export | What it is |
| --- | --- |
| `Settings.string/int/number/boolean/port/url/duration/logLevel/literal/secret` | Leaf setting combinators carrying doc metadata. |
| `Settings.optional(setting)` | Absent → `Option.none()` instead of an error. |
| `Settings.struct(fields)` / `Settings.nested(prefix, setting)` | Composition; nesting prefixes env names (`HTTP_PORT`). |
| `Settings.renderDocs(setting)` | Markdown table: name, type, required, default, secret, description. |
| `load(setting, options?)` | Effect loading + validating; fails with `ConfigLoadError`. |
| `toLayer(tag, setting, options?)` | The same as a `Layer`. |
| `withTestConfig(values)(effect)` | Runs an effect against a fixed value map (tests). |
| `ConfigLoadError` | Tagged error with `issues: ConfigIssue[]`, one per problem. |
| `parseDotEnv(content)` | Minimal dotenv parser (used by `dotEnvFile`). |

Secrets (`Settings.secret`) load as `Redacted<string>` and never render in logs or errors.
