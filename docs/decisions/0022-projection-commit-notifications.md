# ADR-0022: In-process commit notifications wake checkpointed projections

- Status: accepted
- Date: 2026-10-08

## Context

Projection workers poll the global event feed every 500 ms even when no events arrive. This adds database reads and delays read-model updates. Replacing checkpointed delivery with an ephemeral event broadcast would lose restart recovery, replay, and global commit order.

SQL appends can run inside an application transaction. A successful nested append or savepoint does not make events visible to another connection. Notifications must follow the outermost commit.

## Decision

We add an optional scoped `EventBus` service carrying coalesced commit wake-ups. Workers subscribe before catching up, read the durable feed in checkpoint order, then wait for the next notification. Each subscription retains at most one pending signal, and slow workers never block writers.

In-memory stores expose a bus and signal committed appends and imported history automatically. SQL applications share a bus with workers and use `EventBus.notifyAfter` around the outermost committing command. The helper preserves success values and failure causes and sends no notification on failure or cancellation.

## Consequences

Bus-backed workers need no idle polling. Subscription before initial catch-up prevents a lost wake-up when a write races with startup or the transition to waiting. Checkpoints, ordering, at-least-once delivery, rebuild, and worker failure behavior remain unchanged.

The bus is ephemeral and local to one process. Writers must notify the same bus, and separate layer builds create separate instances. External writers or transports with notification loss need an explicit reconciliation interval. Without a bus, workers retain their existing polling behavior. Interrupted workers release subscriptions; restarts recover from the feed.

This version leaves cross-process transports and automatic SQL commit notifications for later. Revisit the decision when independent writers and projection processes require notification delivery without periodic reconciliation. A PostgreSQL transport must publish inside the transaction and deliver after commit, including nested units of work and rollback.
