# structure — instructions for coding agents

Effect-based framework monorepo for agent-focused backend software. Bun workspaces (isolated installs: each package resolves deps via its own `node_modules`), Turborepo, Biome, TypeScript strict.

## Commands

- Install: `bun install` (root). Verify everything: `bun run lint && bun run typecheck && bun run test` (root).
- Per package (run inside `packages/<name>`): `bun x tsc --noEmit`, `bun test`.
- Format/lint fix: `bun x biome check --write <path>` from root.
- IDE/LSP diagnostics in this repo are unreliable — trust only `tsc` and `bun test`.

## Package map

| Package | Use it to |
| --- | --- |
| `@structure-ai/config` | Define typed settings (env/file/overrides), load + validate at startup. |
| `@structure-ai/observability` | Structured logs, correlation ids, metrics, OTLP export. |
| `@structure-ai/domain` | Aggregates (decider: `initial`/`decide`/`evolve`), entity ids, value objects, domain events, error taxonomy. |
| `@structure-ai/cqrs` | Define commands/queries, register handlers, dispatch through the buses. |
| `@structure-ai/authorization` | Define the roles × permissions matrix (`Policy.define`), attach a `Principal`, guard effects / the CQRS bus / HTTP routes. |
| `@structure-ai/eventsourcing` | Event store, aggregate runtime, projections, outbox/inbox (in-memory adapters). |
| `@structure-ai/eventsourcing-sqlite` / `-pg` | Durable adapters for the same ports. |
| `@structure-ai/viewmodel` | Schema-defined read models: typed stores, generated table migrations, event-driven hydration. |
| `@structure-ai/migrations` | Forward-only SQL migrations (`defineMigration`/`makeSet`/`run`/`status` + CLI group). |
| `@structure-ai/runtime` | Readiness checks, shutdown coordinator, Bun entrypoint. |
| `@structure-ai/http` | HttpApi endpoints, OpenAPI docs, health probes, CQRS endpoint bridge (declared business failures → 422), Bun server. |
| `@structure-ai/client` | Typed API client derived from an `Api` type: correlation ids, bearer tokens, per-attempt deadlines, bounded jittered retries on transient transport failures. |
| `@structure-ai/cli` | Typed CLI commands with classified exit codes. |
| `@structure-ai/ai` | LLM calls (Anthropic/OpenAI) with structured output, retries, test model. |
| `@structure-ai/mcp` | Expose tools/resources/commands to coding agents over MCP. |
| `@structure-ai/auth` | Passwords, magic links, passkeys, OAuth, sessions, and tenant-aware auth extension ports. |
| `@structure-ai/auth-sqlite` / `-pg` | Durable Bun-native adapters for the `AuthStore` port. |

Every package: `src/index.ts` is the public API, `README.md` documents it, `test/` shows working usage. Machine index: `llms.txt`. Cross-package narrative (getting started, architecture, operations, ADRs) lives in `docs/` — see `docs/index.md` for what lives where; update the matching doc in the same PR as a cross-package or contract change.

## Recipes (skills)

Task-specific step-by-step guides live in `.agents/skills/*/SKILL.md` (cross-agent directory; Claude Code gets a local symlink via the `install` skill): define-settings, add-observability, wire-runtime, create-aggregate, create-command, create-event-handler, create-view-model, add-migration, integrate-contexts, wire-sql-adapters, serve-http, create-cli-command, call-llm, add-authentication, restrict-access, expose-mcp-tool, read-app-state, install. Follow them when doing the matching task.

## Hard rules

- Effect v3 APIs move fast: verify signatures against `packages/<pkg>/node_modules/<dep>/dist/dts/*.d.ts` before using unfamiliar APIs.
- ESM only; local imports use the `.js` suffix; `exports` maps point at TypeScript source (`./src/index.ts`) — no build step.
- Shared dependency versions live in the root `package.json` `workspaces.catalog`; packages reference them as `"catalog:"`. Internal deps are `"workspace:*"`.
- No `any`, no non-null assertions (Biome errors). Tagged errors (`Data.TaggedError`) with a `classification` field (`transient` | `permanent` | `conflict`).
- Dependency direction (no cycles): config ← observability ← everything; domain ← cqrs ← eventsourcing ← sql adapters ← viewmodel; cqrs ← authorization (http/mcp never depend on it — apps compose; authorization never depends on auth); auth ← auth SQL adapters; migrations and auth are standalone foundations (their Effect dependency aside); runtime ← http/cli; ai and mcp are leaves.
- Never log secrets or prompt bodies; secrets are `Redacted` from config to call site.
- Commands are intent-named; queries never mutate; business rules live in `decide`, not in handlers; cross-aggregate effects go through events (outbox → projection/consumer), never through another context's tables.
- Tests are `bun test` in `packages/<pkg>/test/`, no network, no real providers; sqlite tests may use `:memory:`; pg tests must skip unless `DATABASE_URL` is set.

## VCS

- jj colocated with git. Commit: `jj commit -m "type(scope): message"` (conventional commits, single line, no trailers). Branch/bookmark names: `type/short-description`.

## Contributing

Full contribution flow (issues → branch → tests-first → verification gates → PR) is in [CONTRIBUTING.md](CONTRIBUTING.md). CI (`.github/workflows/ci.yml`) enforces lint, typecheck, tests, the Postgres adapter suite, and conventional PR titles. Releases are tag-driven: pushing `vX.Y.Z` publishes all packages to npm and creates a GitHub release (`.github/workflows/release.yml`; details in CONTRIBUTING.md) — PRs never bump versions. Never add AI/generated-by attribution to commits or PRs.
