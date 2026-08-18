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
| `@structure/config` | Define typed settings (env/file/overrides), load + validate at startup. |
| `@structure/observability` | Structured logs, correlation ids, metrics, OTLP export. |
| `@structure/domain` | Aggregates (decider: `initial`/`decide`/`evolve`), entity ids, value objects, domain events, error taxonomy. |
| `@structure/cqrs` | Define commands/queries, register handlers, dispatch through the buses. |
| `@structure/eventsourcing` | Event store, aggregate runtime, projections, outbox/inbox (in-memory adapters). |
| `@structure/eventsourcing-sqlite` / `-pg` | Durable adapters for the same ports. |
| `@structure/viewmodel` | Schema-defined read models: typed stores, generated table migrations, event-driven hydration. |
| `@structure/migrations` | Forward-only SQL migrations (`defineMigration`/`makeSet`/`run`/`status` + CLI group). |
| `@structure/runtime` | Readiness checks, shutdown coordinator, Bun entrypoint. |
| `@structure/http` | HttpApi endpoints, OpenAPI docs, health probes, CQRS endpoint bridge, Bun server. |
| `@structure/cli` | Typed CLI commands with classified exit codes. |
| `@structure/ai` | LLM calls (Anthropic/OpenAI) with structured output, retries, test model. |
| `@structure/mcp` | Expose tools/resources/commands to coding agents over MCP. |

Every package: `src/index.ts` is the public API, `README.md` documents it, `test/` shows working usage. Machine index: `llms.txt`.

## Recipes (skills)

Task-specific step-by-step guides live in `.claude/skills/*/SKILL.md`: create-aggregate, create-command, create-event-handler, create-view-model, add-migration, read-app-state, expose-mcp-tool. Follow them when doing the matching task.

## Hard rules

- Effect v3 APIs move fast: verify signatures against `packages/<pkg>/node_modules/<dep>/dist/dts/*.d.ts` before using unfamiliar APIs.
- ESM only; local imports use the `.js` suffix; `exports` maps point at TypeScript source (`./src/index.ts`) — no build step.
- Shared dependency versions live in the root `package.json` `workspaces.catalog`; packages reference them as `"catalog:"`. Internal deps are `"workspace:*"`.
- No `any`, no non-null assertions (Biome errors). Tagged errors (`Data.TaggedError`) with a `classification` field (`transient` | `permanent` | `conflict`).
- Dependency direction (no cycles): config ← observability ← everything; domain ← cqrs ← eventsourcing ← sql adapters ← viewmodel; migrations is standalone (cli group aside); runtime ← http/cli; ai and mcp are leaves.
- Never log secrets or prompt bodies; secrets are `Redacted` from config to call site.
- Commands are intent-named; queries never mutate; business rules live in `decide`, not in handlers; cross-aggregate effects go through events (outbox → projection/consumer), never through another context's tables.
- Tests are `bun test` in `packages/<pkg>/test/`, no network, no real providers; sqlite tests may use `:memory:`; pg tests must skip unless `DATABASE_URL` is set.

## VCS

- jj colocated with git. Commit: `jj commit -m "type(scope): message"` (conventional commits, single line, no trailers). Branch/bookmark names: `type/short-description`.

## Contributing

Full contribution flow (issues → branch → tests-first → verification gates → PR) is in [CONTRIBUTING.md](CONTRIBUTING.md). CI (`.github/workflows/ci.yml`) enforces lint, typecheck, tests, the Postgres adapter suite, and conventional PR titles. Never add AI/generated-by attribution to commits or PRs.
