# Architecture

How the `@structure/*` packages compose into an application, and the rules the composition obeys. Package-level APIs live in each package's README; this document owns the cross-package picture.

## The flow of a command

```mermaid
flowchart LR
    Client -->|HTTP / CLI / MCP| Edge[http · cli · mcp]
    Edge -->|dispatch| Bus[cqrs CommandBus]
    Bus -->|validate · authorize · idempotency · trace| Handler[command handler]
    Handler --> AS[eventsourcing AggregateStore]
    AS -->|decide| Agg[domain Aggregate]
    Agg -->|events| AS
    AS -->|append + outbox, one tx| Store[(events · outbox)]
    Store -->|readAll| Proj[viewmodel ViewProjection]
    Proj --> View[(view tables)]
    Store -->|OutboxRelay| Broker[integration events]
    Client -->|query| QBus[cqrs QueryBus]
    QBus --> ViewStore[viewmodel ViewStore]
    ViewStore --> View
```

- The **edge** (`http`, `cli`, `mcp`) translates transport concerns and dispatches; it holds no business logic.
- The **bus** (`cqrs`) owns boundary validation (shape), authorization of the action, idempotency keys, tracing/metrics. Business rules live one step deeper.
- The **aggregate** (`domain`) is a pure decider: `decide` accepts/rejects, `evolve` folds. The same definition serves state-stored and event-sourced persistence.
- The **aggregate store** (`eventsourcing`) enforces optimistic concurrency (`expectedVersion` append) and stamps event metadata (correlation/causation).
- **Read models** (`viewmodel`) are hydrated asynchronously by projections; queries only ever read them.
- **Cross-context effects** leave through the transactional **outbox**; consumers are made idempotent by the **inbox**.

## Dependency direction

```mermaid
flowchart TD
    config --> observability
    observability --> cqrs & runtime & http & cli & ai
    domain --> cqrs --> eventsourcing
    eventsourcing --> essqlite[eventsourcing-sqlite] & espg[eventsourcing-pg]
    eventsourcing --> viewmodel
    migrations --> viewmodel
    runtime --> http & cli
    cqrs --> mcp
```

No cycles; `migrations` is standalone (its CLI group aside); `ai` and `mcp` are leaves. A PR that needs to violate this direction is redesigning the system and needs an ADR.

## Consistency model

- **Strong** inside one aggregate transaction: `append(stream, expectedVersion, events)` either wins or fails `ConcurrencyConflict` (retryable via `executeWithRetry`).
- **Eventual** everywhere else: view models converge via checkpointed, at-least-once projections; integration effects converge via outbox relay + inbox dedup. Exactly-once *business effects* come from expected-version appends and idempotency keys, never from a transport guarantee.
- Read-your-own-write: return the command ack (id + version) and poll the view for that version — nothing pretends projections are synchronous.

## Error taxonomy

Every framework error is a `Data.TaggedError` carrying `classification`:

| Classification | Meaning | Retry? | Edge mapping (http/cli) |
| --- | --- | --- | --- |
| `transient` | Timeouts, throttling, transport | Yes, bounded backoff + jitter | 504 / exit 75 |
| `permanent` | Validation, invariants, not-found, auth | Never | 400/403/404 / exit 1 |
| `conflict` | Optimistic concurrency lost | Reload then retry the whole command | 409 / exit 1 |

The classification is decided where the error is born and preserved across layers — retry policies, HTTP status mapping, and CLI exit codes all read it instead of guessing from error types.

## Where each concern is handled exactly once

| Concern | Owner |
| --- | --- |
| Config validation (all errors at once, fail before work) | `config` at startup, via `runtime` |
| Correlation ids on logs + spans | `observability` (`Correlation`), injected at the edge |
| Traffic/error/latency metrics per boundary | `Metrics.track` at bus, HTTP, AI call sites |
| Retries | One owner per operation: `executeWithRetry` (conflicts), `OutboxRelay` (publishing), `ai` (transient LLM failures). Never nested. |
| Secrets | `Redacted` from `Settings.secret` to call site; never logged |
