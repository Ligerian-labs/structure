# ADR-0023: PostgreSQL commit notifications wake projections across processes

- Status: accepted
- Date: 2026-10-08
- Extends: [ADR-0022](0022-projection-commit-notifications.md)

## Context

The in-process event bus cannot wake independently running projection workers. Command wrappers can miss a committed event if a workflow fails later, and notifying after a nested append or savepoint can signal before the outer transaction commits. External database writers also bypass application wrappers. Projections need cross-process wake-ups without continuous event-store polling, while retaining durable checkpoints and replay.

## Decision

PostgreSQL schema revision 5 adds an `AFTER INSERT` statement trigger to each events table. A transition table suppresses signals for inserts that wrote no rows. The trigger calls `pg_notify` inside the writing transaction; PostgreSQL delivers only after the outermost commit and discards rolled-back signals. A constant payload lets notifications coalesce within a transaction and carries no event content. The channel includes the relation OID, isolating feeds across table prefixes and schemas. Existing schema revisions remain unchanged.

The PostgreSQL all-in-one layer exposes an `EventBus`. Applications composing their own client and stores can provide `eventBusLayer` after migration. One dedicated connection per bus completes `LISTEN` before layer acquisition returns; local workers subscribe before catch-up. Pending signals coalesce in the bounded local hub. PostgreSQL transports wake-ups; persisted history remains the delivery source. Applications own and supervise their worker processes.

The transport uses a declared `pg` dependency, already used by `@effect/sql-pg`, because the installed Effect client's listener suppresses connection errors. The dedicated client explicitly observes connection error and end events. Disconnects fail pending and future waits with `PersistenceError`, which propagates through the shared event-bus port and projection workers. Manual `notify` executes through the ambient SQL client, preserving transaction semantics.

## Consequences

Appends, transactional outbox appends, history imports and direct SQL inserts wake other processes automatically. Rollback sends nothing, and a later workflow failure cannot hide an earlier committed event. PostgreSQL writers need no `notifyAfter` wrapper. Existing in-process and SQLite composition remain available.

Workers with a bus perform no idle event-store polling unless an interval is explicitly configured. A disconnected listener stops the worker instead of waiting silently. Supervision must restart the whole worker with a fresh transport layer; initial catch-up recovers writes committed while offline. Notifications are ephemeral, and checkpoints remain responsible for recovery. The adapter does not silently reconnect or claim exactly-once delivery.

The listener consumes one connection outside the query pool and requires direct connections or session pooling. PostgreSQL 14 or later is required for the idempotent trigger replacement. One worker owns each projection name and read model; this change adds no distributed worker lease. Direct SQL writers still follow the existing global commit-order contract. Revision 5 preserves history, and listener startup rejects a missing or disabled notification trigger.

The `EventBus` port and `notifyAfter` error channels now admit `PersistenceError` for transport failures. Local bus creation remains infallible. PostgreSQL layer acquisition can fail with that typed error in addition to its existing `SqlError` channel.
