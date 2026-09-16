# ADR-0020: Typed persistence failures and explicit cause boundaries

- Status: accepted; supersedes the defect-based append error contract in ADR-0015
- Date: 2026-09-16

## Context

Persistence ports declared `E = never`, or only concurrency conflicts. Adapters used `orDie` to fit those contracts, so callers could not recover from outages with `catchTag`. Some terminal boundaries inspected only the first failure of a compound cause, hiding defects or interruption. The second-factor hook also required an infallible effect, encouraging a documented fallback that treated a failed enrollment read as unenrolled.

## Decision

Expose `PersistenceError` from the shared domain package through persistence ports, aggregate/projection workflows, view stores and CQRS. It contains an operation name and the original diagnostic cause, and stays separate from public business failure schemas. Adapters translate expected SQL and serialization failures near their source. SQL-specific migration and transaction helpers retain their explicit SQL error channels.

`PersistenceError` defaults to permanent classification, meaning no automatic retry. A storage failure can reflect invalid data or an ambiguous committed write. Recovery requires the owning operation's idempotency contract, not a free-form classification copied from an unknown value.

Use typed Effect recovery for expected failures. Whole-cause handling is reserved for documented transport, process, worker and cleanup boundaries. These boundaries must distinguish cancellation, defects and typed failures, including compound causes. Unknown values require constructors, framework predicates or validated schemas before accessing error fields.

HTTP renders defects as safe 500 responses. MCP tools return a fixed internal-error message for defects. Their terminal SDK boundary consumes typed messages, logs the original compound cause, and preserves its interruption and defect nodes. Readiness intentionally consumes expected failures and defects as diagnostic `not ready` results; interruption is never readiness success. Fixture context maps typed failures while retaining the cause tree. Idempotency cleanup retains both the dispatch and release failure.

Jobs supervise handler, completion and heartbeat failures. Only a single expected handler failure participates in retry/dead-letter policy. The Nisshi relay retries only explicitly transient broker failures. Auth's second-factor hook accepts typed auth failures and must prevent session creation when enrollment lookup fails.

## Consequences

Consumers that annotated persistence calls as infallible must include `PersistenceError` or handle it explicitly. Custom adapters can return typed failures without defect casts. Command handlers can propagate infrastructure failures without exposing them as business refusals. Worker callers must supervise the expanded error channels.

Nisshi delivery remains at least once: a failed append can leave pending rows that later publish. This decision changes its error channel, not its commit guarantees.

Deliberate wiring invariants remain defects, including duplicate handler registration, impossible validated states and invalid schema round-trips. Tests cover real adapter outages, stored-data corruption, tag-shaped impostors, defects, cancellation and compound causes. Revisit the shared error taxonomy when a concrete adapter can distinguish safe retry from ambiguous commit with evidence.
