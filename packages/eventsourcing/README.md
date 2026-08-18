# @structure/eventsourcing

Event sourcing on top of `@structure/domain` deciders: ports for the event store, snapshots, checkpoints, outbox, and inbox; an aggregate runtime with optimistic concurrency; projections with checkpoints and rebuild; an outbox relay with bounded retries and dead-lettering. In-memory implementations of every port ship for tests and as the starting shape — swap in `@structure/eventsourcing-sqlite` or `-pg` for durability without touching domain code.

## Usage

```ts
import { AggregateStore, EventRegistry, InMemoryAll, Projection } from "@structure/eventsourcing";
import { Effect } from "effect";

const registry = EventRegistry.make([
  { schema: InvoiceApproved, schemaVersion: 1 },
  { schema: InvoiceRejected, schemaVersion: 1 },
]);

const program = Effect.gen(function* () {
  const store = yield* AggregateStore.make(Invoice, registry, { snapshotEvery: 100 });
  const result = yield* store.executeWithRetry(invoiceId, {
    _tag: "ApproveInvoice", id: invoiceId, approver: "ada",
  }, { correlationId });
  // result: { state, version, events }
}).pipe(Effect.provide(InMemoryAll));
```

## Exports

| Export | What it is |
| --- | --- |
| `EventRegistry.make(entries)` | Schema-based codec: `{ schema, schemaVersion, upcasters? }` per event; decode applies upcasters from the stored version up before validating. |
| `EventStore` | `append(stream, expectedVersion, events)` failing `ConcurrencyConflict` (version 0 = stream must not exist); `read` per stream; `readAll` in global order for projections. |
| `AggregateStore.make(aggregate, registry, opts?)` | `load` (fold history), `execute` (load → decide → append with expected version), `executeWithRetry` (reload+retry on conflict only, default 3); stamps `EventMetadata` incl. correlation/causation. Stream naming: `<AggregateName>-<id>` (aggregate names must not contain `-`). |
| `SnapshotStore` | Optional; picked up from context when provided, written every `snapshotEvery` events. |
| `Projection.make/catchup/run/rebuild` + `CheckpointStore` | Named projections, at-least-once, checkpoint per batch, unknown event types skipped and counted, `rebuild` replays with `live: false`. |
| `Outbox` + `OutboxRelay.run/drain` | Pending → publish → mark; exponential backoff with jitter; after `maxAttempts` (default 5) entries dead-letter with the last error kept for diagnosis. |
| `Inbox` + `Inbox.dedupe(consumerId, messageId)` | Idempotent consumers: runs the effect only for unseen messages, marks after success. |
| `InMemory*` layers, `InMemoryAll` | In-memory implementations of every port. |

Exactly-once business effects come from expected-version appends plus inbox dedup — not from any transport guarantee.
