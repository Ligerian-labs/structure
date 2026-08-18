# structure

Reusable, Effect-based framework for building agent-focused backend software: HTTP APIs with OpenAPI docs, CLIs, DDD/CQRS/event-sourcing building blocks, LLM bindings, MCP servers — with configuration, observability, and graceful lifecycle handled once.

Monorepo of small, independently importable packages under the `@structure/*` scope. Bun workspaces + Turborepo + Biome. Packages are consumed as TypeScript source via `workspace:*` (no publish pipeline yet).

## Packages

| Package | Purpose |
| --- | --- |
| `@structure/config` | Typed env + config: settings DSL, layered providers (overrides → env → file → dotenv → defaults), startup validation reporting all issues, redacted secrets, generated settings docs. |
| `@structure/observability` | Structured JSON logging, correlation context (correlation/causation/request ids), boundary metrics, OTLP export of traces/metrics/logs. |
| `@structure/domain` | DDD tactical bindings: branded entity ids, schema value objects, decider-style aggregates (`decide`/`evolve`), domain events, repository port, classified error taxonomy. |
| `@structure/cqrs` | Schema-typed command/query buses: boundary validation, authorization hook, idempotency keys, tracing + metrics per dispatch. |
| `@structure/eventsourcing` | Event store / snapshot / checkpoint / outbox / inbox ports, aggregate runtime with optimistic concurrency, projections with checkpoints and rebuild, in-memory adapters. |
| `@structure/eventsourcing-sqlite` | Durable adapters over `bun:sqlite`. |
| `@structure/eventsourcing-pg` | Durable adapters over PostgreSQL (`@effect/sql-pg`). |
| `@structure/viewmodel` | Schema-defined read models (query-side "ORM"): typed stores, generated table migrations, and event-driven hydration with rebuild. |
| `@structure/migrations` | Versioned, ordered, forward-only SQL migrations (dialect-agnostic over `@effect/sql`), with status reporting and a ready-made CLI command group. |
| `@structure/runtime` | App bootstrap: config-first startup, readiness checks, shutdown coordinator with bounded finalizers, Bun entrypoint. |
| `@structure/http` | Routes/handlers on `@effect/platform` HttpApi: OpenAPI + Swagger UI, health probes, error mapping, CQRS bridge, Bun server with graceful shutdown. |
| `@structure/cli` | CLI commands on `@effect/cli` with config/observability pre-wired and classified exit codes. |
| `@structure/ai` | LLM provider bindings on `@effect/ai` (Anthropic/OpenAI): typed calls, structured output, bounded retries, token/cost metrics, deterministic test model. |
| `@structure/mcp` | MCP server bindings: expose schema-typed tools/resources and CQRS messages to coding agents over stdio or HTTP. |

## Commands

```sh
bun install        # install all workspaces
bun run lint       # biome check (root-wide)
bun run typecheck  # turbo run typecheck (tsc --noEmit per package)
bun run test       # turbo run test (bun test per package)
```

## Design rules

- Bounded contexts own their model, persistence, and contracts; commands are intent-named and validated at the boundary; business rules live in the domain.
- Strong consistency inside one aggregate transaction; everything cross-aggregate is events + eventual consistency (outbox, idempotent consumers, replayable projections).
- Configuration is typed, validated at startup (all errors at once), immutable for the process lifetime; secrets are `Redacted` end to end.
- Every boundary is loggable (structured, correlated), measurable (traffic/errors/latency), and traceable; telemetry failure never takes down the workload.
- Failures are classified (`transient` / `permanent` / `conflict`); only transient failures are retried, with bounded backoff and jitter.

Start with `docs/getting-started.md` for an end-to-end walkthrough; `docs/architecture.md` and `docs/operations.md` own the cross-package picture, and `docs/decisions/` records why (ADRs). See `llms.txt` for a machine-oriented index and each package's `README.md` for its API. Conventions for coding agents live in `AGENTS.md`; task recipes (create an aggregate, a command, a view model, ...) live in `.claude/skills/`. To contribute — human or agent — start with `CONTRIBUTING.md`; CI runs the same gates you run locally (`lint`, `typecheck`, `test`, plus the Postgres adapter suite).
