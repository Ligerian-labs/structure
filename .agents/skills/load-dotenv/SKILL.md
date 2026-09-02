---
name: load-dotenv
description: Load .env files (cascade, expansion, precedence) into a @structure-based app, verify required variables, and edit .env files safely. Use when setting up local development environment files or a dotenv CLI.
---

# Load dotenv files

`.env` files are a local-development convenience: they sit **below** the real environment (a variable already set keeps its value) and are loaded explicitly at the entrypoint, never implicitly by the framework. Reference: `packages/dotenv/README.md`, decision: `docs/decisions/0017-dotenv-as-a-package-above-config.md`.

## Steps

1. **Keep files out of git** — `.env` and `.env.*` are ignored, `.env.example` is committed with every key and empty values:

```
# .env.example
PORT=
DATABASE_URL=
```

2. **Load at the entrypoint**, feeding `@structure-ai/config` without touching `process.env`:

```ts
import { load as loadSettings } from "@structure-ai/config";
import * as Dotenv from "@structure-ai/dotenv";
import { Effect } from "effect";

const config = Effect.gen(function* () {
  const env = yield* Dotenv.environment(); // .env → .env.local → .env.$NODE_ENV → .env.$NODE_ENV.local
  return yield* loadSettings(appSettings, { env });
});
```

Alternatives: `Dotenv.configProvider()` for raw Effect `Config`, or `Dotenv.layer()` at the top of the layer stack when a library you use reads `process.env` directly.

3. **Write the files with the conventions the loader understands**: quotes only when needed, single quotes for literal values (no expansion), `${VAR:-default}` for references, `#` comments. Multi-line values (PEM keys) go in double quotes across lines.

4. **Add the CLI group** so operators and agents can verify a checkout: `dotenvCommand({ settings: appSettings, example: ".env.example" })` from `@structure-ai/dotenv/cli`, mounted with `withSubcommands`. `<app> dotenv check` exits 78 listing every missing key; `<app> dotenv print` shows what the files contribute with values redacted; `<app> dotenv run -- bun test` runs a command with the loaded environment; `<app> dotenv set KEY VALUE` edits a file without touching comments.

5. **Edit files from code** with `setValues(path, { KEY: value })` / `unsetKeys(path, keys)` — never with string concatenation; a value that cannot be quoted losslessly fails instead of corrupting the file.

6. **Test** with a temp directory (`mkdtemp`), explicit `files`, and an injected `env: {}` so the host environment cannot leak in. Follow `packages/dotenv/test/load.test.ts`.

## Rules

- Bun preloads `.env`, `.env.local` and `.env.$NODE_ENV` itself; with the default precedence that is harmless. Reach for `override: true` only in a development entrypoint where a `.env.<env>.local` value must beat one Bun already loaded, never in production.
- `.env.local` is skipped when the environment is `test`: tests read `.env` and `.env.test` only.
- Secrets in `.env` files are still secrets: they go through `Settings.secret`, are never logged, and `print` stays redacted in scripts.
- Production processes get their environment from the platform; a missing `.env` there is not an error (cascade files are optional), a missing required variable is (`check`, or `ConfigLoadError` at startup).

## Verify

`bun x tsc --noEmit && bun test` in the package.
