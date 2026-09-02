# 0017 — dotenv support is a package above `config`, with the classic precedence rule

## Status

Accepted (2026-09-02).

## Context

`@structure-ai/config` shipped a minimal dotenv parser (`KEY=value`, comments, simple quotes) behind the `dotEnvFile` load option — enough for a demo, not for the files developers actually keep: multi-line PEM keys, inline comments, `${VAR:-default}` references, a `.env.local` that must never be committed, per-environment overrides. Bun also preloads `.env`, `.env.local` and `.env.$NODE_ENV` into `process.env` before any code runs, so whatever the framework does has to coexist with that.

Options considered:

1. Grow the parser inside `config`. Keeps one package, but drags file editing, a CLI group and process spawning into the foundation every other package depends on.
2. A standalone `dotenv` package below `config`, with `config` depending on it. Moves `parseDotEnv` out of `config` (a breaking export removal) and makes the bottom of the dependency graph heavier.
3. A `dotenv` package **above** `config`, importable on its own, feeding `config` through its existing `env` load option.

## Decision

Option 3. `@structure-ai/dotenv` depends on `config` (for `Setting` metadata in `check`) and on `cli` (for its `./cli` command group) and stays importable standalone for parsing, loading, expansion and file edits. `config` keeps its minimal parser untouched; the integration point is `load(settings, { env: yield* Dotenv.environment() })`.

Semantics fixed here:

- **Parsing** matches the `dotenv` package's test corpus: keys `[\w.-]+`, optional `export`, `=` or `: ` separators, single/double/backtick quotes spanning lines, `\n` expanded only inside double quotes, unquoted values cut at the first `#`, malformed lines ignored. Parsing never fails.
- **Expansion** matches `dotenv-expand`'s syntax (`$VAR`, `${VAR}`, `:-`, `-`, `:+`, `+`, `\$`), with two deliberate refinements: single-quoted values are literal (shell and Bun behaviour), and a reference cycle is an error rather than a silent partial result.
- **Precedence** is the classic dotenv rule: the environment wins over files unless `override: true`. This is what makes Bun's preloading harmless — identical values are already present. Lookups during expansion follow the same rule so an expanded value equals what the process will actually see.
- **Cascade**: `.env` → `.env.local` → `.env.<env>` → `.env.<env>.local`, driven by `NODE_ENV` by default, `.env.local` skipped for `test`; missing cascade files are skipped, explicitly listed files must exist.
- **Writing** preserves every byte that is not the edited assignment. Values are quoted so they parse back identically; a value that mixes all three quote characters is refused instead of written lossy.
- **Secrets**: values stay plain strings (a parser cannot know which keys are secret); errors, reports and the CLI never print values unless `--reveal` is passed.
- **Out of scope**: encrypted `.env.vault` files and key management — a cryptographic surface with a key-distribution story this framework does not own; use the deployment platform's secret store.
- **Bun only**: files are read with Node's `fs` but `run` spawns through `Bun.spawn`; no Node CI matrix.

## Consequences

- Dependency direction gains `config ← dotenv` and `cli ← dotenv/cli`; `runtime` does not depend on `dotenv` — applications load `.env` files explicitly at their entrypoint, which keeps production processes free of file lookups unless they opt in.
- `config`'s `dotEnvFile` option remains for backward compatibility but the recipe (`load-dotenv` skill) points to this package.
- A `dotenv run` child's exact exit code cannot pass through the CLI runner's classified codes: a non-zero child exit maps to exit 1 with the code in the message.
- Revisit if a Node runtime target appears (swap `Bun.spawn` for `child_process`), or if encrypted files become a real deployment need (a separate adapter, not this package).
