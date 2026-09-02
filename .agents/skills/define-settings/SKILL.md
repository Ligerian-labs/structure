---
name: define-settings
description: Define and load typed application settings (env, dotenv, JSON file, overrides) in a @structure-based app. Use when adding configuration or environment variables.
---

# Define settings

Settings are declared once as a typed value and loaded at startup; validation reports **all** issues together and fails before the process accepts work. Precedence (highest wins): explicit overrides → environment variables → JSON config file → dotenv file → code defaults. Reference: `packages/config/README.md`.

## Steps

1. **Declare them** with doc metadata — the declaration is also the documentation source:

```ts
import { Settings } from "@structure-ai/config";
import { Duration } from "effect";

export const appSettings = Settings.struct({
  host: Settings.string("HOST", { default: "0.0.0.0" }),
  port: Settings.port("PORT", { description: "listen port" }),
  timeout: Settings.duration("TIMEOUT", { default: Duration.seconds(5) }),
  apiKey: Settings.secret("API_KEY"),                       // Redacted<string>
  otlpUrl: Settings.optional(Settings.url("OTLP_URL")),      // Option<URL>
  http: Settings.nested("HTTP", Settings.struct({            // env: HTTP_PORT
    port: Settings.port("PORT", { default: 3000 }),
  })),
});
```

2. **Load at startup** — `load(appSettings, { configFile: "config.json" })` (for local `.env` files pass `env: yield* Dotenv.environment()` from `@structure-ai/dotenv`, see the `load-dotenv` skill; the minimal `dotEnvFile` option remains for a single plain file) fails with one `ConfigLoadError` carrying every `ConfigIssue`, or use `Settings.toLayer(AppConfigTag, appSettings, options)` to provide the value as a layer. Blank environment values (`PORT=`, as `docker compose` forwards unset `${VAR:-}` knobs) count as unset by default, so defaults apply and `optional` loads `None`; pass `blankMeansUnset: false` only when a literal empty string is meaningful.
3. **Derive the reference docs** from the same declaration: `Settings.renderDocs(appSettings)` renders the markdown settings table for the README.
4. **Reuse ready-made groups** where they exist: `observabilitySettings` from `@structure-ai/observability`, `aiSettings` from `@structure-ai/ai`.
5. **Tests and CLIs:** `load(appSettings, { env: { PORT: "8080" } })` loads from an injected environment map (same `_` nesting, same precedence below `overrides`) — no `process.env` mutation. `withTestConfig({ PORT: "8080" })(effect)` runs an effect against a fixed value map when there is no `load` call to pass options to. Follow `packages/config/test/config.test.ts`.

## Rules

- Secrets go through `Settings.secret` and stay `Redacted<string>` to the call site — never `.value` them into logs, errors, or the settings docs table.
- No `process.env` reads scattered in code; the settings module is the only place environment is touched.
- Nest with `Settings.nested(prefix, ...)` instead of flattening names by hand.
- Failure to configure is a startup failure, not a runtime one — don't default a value that has no safe default; omit `default` and make it required.

## Verify

`bun x tsc --noEmit && bun test` in the package.
