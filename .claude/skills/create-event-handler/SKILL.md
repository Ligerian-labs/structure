---
name: create-event-handler
description: React to domain events in a @structure-based app - projections that update read models, or consumers that trigger side effects. Use when something must happen after an event.
---

# Create an event handler

Two shapes, pick deliberately:
- **Projection** — updates a read model from events (no external side effects, safe to replay). Use `ViewProjection` (`@structure/viewmodel`) when the target is a view-model table, or raw `Projection` (`@structure/eventsourcing`) for anything else.
- **Consumer** — triggers side effects (send email, call an API, dispatch a follow-up command). Must be idempotent and must distinguish live delivery from replay.

Reference: `packages/eventsourcing/README.md`, `packages/viewmodel/README.md`.

## Projection steps

1. Register the event schemas in an `EventRegistry` (same registry as the writer, or a consumer-local one containing only the events you care about — unknown types are skipped and counted).
2. Define handlers keyed by event tag:

```ts
import { Projection } from "@structure/eventsourcing";

const invoiceStats = Projection.make({
  name: "invoice-stats", // checkpoint identity — never rename casually
  registry,
  when: {
    InvoiceApproved: (event, stored, ctx) => /* Effect: update read model */,
  },
});
```

3. Run it: `Projection.catchup` (process until caught up — tests, batch jobs), `Projection.run` (poll forever — a worker process), `Projection.rebuild(projection, reset)` (reset + full replay with `ctx.live === false`).
4. Handlers must be idempotent: delivery is at-least-once, checkpoint is saved per batch.

## Consumer steps

1. Same registry/handler structure, but wrap each side effect in `Inbox.dedupe(consumerId, stored.metadata.eventId)` so duplicates are no-ops.
2. Gate irreversible effects on `ctx.live === true` — a rebuild must not resend emails.
3. Cross-context messages go through the `Outbox` (`OutboxRelay` handles bounded retry + dead letters); never write into another context's tables.

## Tests

Append events to an in-memory (or sqlite `:memory:`) event store, `catchup`, assert the outcome; append more, catchup again and prove no double-apply; exercise `rebuild`. Follow `packages/eventsourcing/test/projection.test.ts`.

## Verify

`bun x tsc --noEmit && bun test` in the package.
