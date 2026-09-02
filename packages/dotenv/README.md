# @structure-ai/dotenv

First-class `.env` support on Effect. Parsing follows the `dotenv` package byte for byte, expansion follows `dotenv-expand`, the file cascade follows the `.env` / `.env.local` / `.env.<env>` / `.env.<env>.local` convention, and files can be edited in place without losing comments or ordering. The loaded values feed `@structure-ai/config` or Effect `Config` without touching `process.env`, or are applied to `process.env` the classic way. Bun only.

## Usage

```ts
import { load as loadSettings, Settings } from "@structure-ai/config";
import * as Dotenv from "@structure-ai/dotenv";
import { Effect } from "effect";

const settings = Settings.struct({
  port: Settings.port("PORT", { default: 3000 }),
  databaseUrl: Settings.secret("DATABASE_URL"),
});

// Local development: .env files below the real environment, no global mutation.
const program = Effect.gen(function* () {
  const env = yield* Dotenv.environment(); // process.env merged with .env, .env.local, .env.$NODE_ENV, .env.$NODE_ENV.local
  const config = yield* loadSettings(settings, { env });
  // config.port: number, config.databaseUrl: Redacted<string>
});

// Or the classic way, at the top of the layer stack: writes into process.env.
const app = Layer.provideMerge(AppLive, Dotenv.layer());
```

Rules the loader applies:

- **Precedence.** Later files in the cascade override earlier ones. A variable already present in the environment keeps its value and the file's value is reported as `shadowed` — unless `override: true`. This is the classic dotenv rule, and it makes Bun's own preloading of `.env`, `.env.local` and `.env.$NODE_ENV` harmless (same values, already there). Only when a `.env.<env>.local` value must beat one Bun already loaded from `.env` do you need `override: true` (development only) or `bun --env-file=/dev/null`.
- **Cascade.** `environment` defaults to `NODE_ENV`; an empty name loads only `.env` and `.env.local`. `.env.local` is skipped when the environment is `test` so test runs stay reproducible. Missing cascade files are skipped; explicit `files` must exist.
- **Expansion.** `$VAR`, `${VAR}`, `${VAR:-default}`, `${VAR-default}`, `${VAR:+alt}`, `${VAR+alt}`; `\$` is a literal dollar. References resolve from the environment first, then from the files (files first with `override`). Single-quoted values are literal. Undefined names expand to `""`; a cycle fails with `DotenvError` of kind `expand`.
- **Secrets.** Parsed values are plain strings — a dotenv parser cannot know which keys are secrets; route them through `Settings.secret`. Errors and the CLI never print values unless asked (`print --reveal`).

## CLI

```ts
import { dotenvCommand } from "@structure-ai/dotenv/cli";

const root = withSubcommands(app, [dotenvCommand({ settings, example: ".env.example" })]);
```

| Command | Does |
| --- | --- |
| `dotenv check [--example FILE] [--allow-empty]` | Lists missing, empty and undeclared variables against the settings definition and/or example file; exits 78 (`ConfigLoadError`, one issue per key) when a required one is missing or empty. |
| `dotenv print [--reveal] [--json]` | What the files contribute and which keys the environment shadows; values `<redacted>` unless `--reveal`. |
| `dotenv run -- <command...>` | Runs a command with the loaded environment. A non-zero child exit fails the command (exit 1) with the child's code in the message. |
| `dotenv set KEY VALUE [--file .env]` / `dotenv unset KEY... [--file .env]` | Edit a file in place: existing lines rewritten (export prefix and inline comment kept), other bytes untouched, file created when absent. |

## Exports

| Export | What it is |
| --- | --- |
| `parse(content)` | dotenv-compatible parsing into a `Map`; never fails, last duplicate wins. |
| `load(options?)` | `Effect<Loaded, DotenvError>`: `{ values, files, shadowed, sources }` after precedence — nothing written anywhere. |
| `environment(options?)` | The merged environment as a `Record`, for `@structure-ai/config`'s `load(settings, { env })`. |
| `configProvider(options?)` | A `ConfigProvider` over that environment (`_` nesting) for `Effect.withConfigProvider` / `Layer.setConfigProvider`. |
| `apply(options?)` / `layer(options?)` | Load and write the values into `process.env`; the layer form for the top of a layer stack. |
| `LoadOptions` | `cwd`, `files`, `environment`, `env`, `override`, `expand`. |
| `cascade(environment)` | The conventional file list for an environment name. |
| `check(options)` / `toConfigIssues(report)` | Compare the merged environment against a `Setting` (required = no default, not optional) and/or an example file (every key required); report `{ required, missing, empty, unknown }`, convertible to `ConfigLoadError` issues. |
| `setValues(path, entries)` / `unsetKeys(path, keys)` | Edit a file in place. |
| `Document.parse/assignments/values/set/unset/render` | The lossless document model behind the writers: quote style, `export` prefix, inline comments, line numbers, line endings. |
| `formatValue(value)` / `stringify(entries)` | Quote a value so it reads back unchanged (bare → single → double/backtick with `$` escaped; a value mixing all three quotes is a `write` error). |
| `expand(entries, options?)` | The expansion step on its own. |
| `DotenvError` | `{ kind: read \| missing \| expand \| write \| run \| invalid, reason, path?, key?, exitCode? }`, `classification: "permanent"`; messages never carry values. |

Out of scope by decision (ADR-0017): encrypted `.env.vault` files and key management.
