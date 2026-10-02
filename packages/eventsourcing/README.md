# @structure-ai/eventsourcing

Event sourcing on top of `@structure-ai/domain` deciders: ports for the event store, snapshots, checkpoints, outbox, and inbox; an aggregate runtime with optimistic concurrency; projections with checkpoints and rebuild; an outbox relay with bounded retries and dead-lettering. In-memory implementations of every port ship for tests and as the starting shape — swap in `@structure-ai/eventsourcing-sqlite` or `-pg` for durability without touching domain code.

## Usage

```ts
import { AggregateStore, EventRegistry, InMemoryAll, Projection } from "@structure-ai/eventsourcing";
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
| `EventStore` | `append(stream, expectedVersion, events)` failing `ConcurrencyConflict | PersistenceError` (version 0 = stream must not exist); `read` per stream; `readAll` in global order for projections, optionally narrowed to one or several envelope partitions (`readAll({ partition })`: same positions, same order, same checkpoint guarantee; events without a partition never match, so an unpartitioned store filtered by partition yields nothing). |
| `StreamEraser` + `ERASED_EVENT_TYPE` | Destructive retention for one stream: `eraseStream({ streamName, expectedVersion, reason })` rewrites every event to a payload-free `Erased` tombstone (positions/versions intact, `readAll` gap-free, checkpoints stay valid), deletes the stream's snapshot, and pins the stream against future appends. Idempotent; audit reason kept. In-memory, SQLite, and PostgreSQL adapters (not Nisshi — immutable topic, ADR-0015). |
| `HistoryImporter` + `HistoryImport.checksum` | Imports a frozen history with source positions, stream versions, ids, timestamps, correlation/causation, actor, partition, origin and extensions intact. Batches are atomic, checksum-verified, resumable, and idempotent. |
| `AggregateStore.make(aggregate, registry, opts?)` | `load` (fold history), `execute` (load → decide → append with expected version), `executeWithRetry` (reload+retry on conflict only, default 3); stamps `EventMetadata` including correlation, causation, optional actor, and the command's `partition` and `extensions` (never `origin`). Stream naming: `<AggregateName>-<id>` (aggregate names must not contain `-`). |
| `SnapshotStore` | Optional; picked up from context when provided, written every `snapshotEvery` events. |
| `Projection.make/catchup/run/rebuild` + `CheckpointStore` | Named projections, at-least-once, checkpoint per batch, unknown event types skipped and counted, `rebuild` replays with `live: false`. |
| `Outbox` + `OutboxRelay.run/drain` | Pending → claim → publish → settle; exponential backoff with jitter; after `maxAttempts` (default 5) entries dead-letter with the last error kept for diagnosis. Scheduling is durable: `OutboxMessage.availableAt` delays the first attempt, `pending` returns only due entries, the relay persists the next eligible time through `markFailed` (backoff survives restarts), and `replay(ids)` requeues dead letters fresh. Delivery ownership is claim-based: `claim(limit, lease)` atomically takes a lease on due entries (a `FOR UPDATE SKIP LOCKED` UPDATE on PostgreSQL, one UPDATE on SQLite, a `Ref` transaction in memory), so concurrent relays never hold the same entry; settlements (`markPublished`/`markFailed`/`markDead`) take the claim's token and are fenced — a settlement from a crashed or slow worker whose lease expired and was recovered elsewhere returns `false` and writes nothing. A lease that lapses without settlement makes the entry claimable again (at-least-once delivery survives worker crashes). `OutboxRelayOptions.lease` (default 30 seconds) bounds how long a relay may hold entries. |
| `Inbox` + `Inbox.dedupe(consumerId, messageId)` | Idempotent consumers: runs the effect only for unseen messages, marks after success. |
| `InMemory*` layers, `InMemoryAll` | In-memory implementations of every port. |

Exactly-once business effects come from expected-version appends plus inbox dedup — not from any transport guarantee.

## Partitions

`CommandMetadata.partition` places every event of the command on a named subset of the store (an agency, a tenant, a shard); the framework enforces one rule — a stream's partition never changes — and decides nothing about what the key means or who may write to it (see [ADR-0018](../../docs/decisions/0018-partition-on-the-event-envelope.md)). `readAll({ partition: "agency-42" })` (or a list) gives an exporter, a replica, or any caller driving `readAll` itself that subset only, in global order with the global positions. `Projection` is not partition-aware yet: `catchup`, `run` and `rebuild` read the whole feed (a partition-scoped projection is a follow-up, not part of this contract). Adapters that cannot honour the filter fail instead of ignoring it; `readAllPartitions` is the helper they normalise the option with.

## Importing frozen history

Use `HistoryImporter`, not `EventStore.append`, when a migration must preserve the source store's global order. Build batches in ascending global-position order and keep `importId` and each `batchId` stable across retries. Compute the required checksum with `HistoryImport.checksum(events)`.

The first batch only runs against an empty target. Each successful batch returns a `resumeToken`; pass it to the next batch. If the caller loses a response, retry the same batch with the same ids and input to recover its result. Reusing a batch id with different data fails. Mark the last batch `complete: true`; later batches then fail.

The importer validates metadata, registry decoding, event-id uniqueness, global positions, and per-stream versions before committing. It does not enqueue outbox messages. If historical publication is intentional, map the imported events to application-owned `OutboxMessage` values and enqueue them explicitly after the import completes; the importer cannot infer topics or integration payloads.

Run imports while live writers are stopped. If the target changes between batches, resume fails instead of mixing histories. A batch call returns only after PostgreSQL's live-write sequence matches the imported history. If a call is interrupted after its transaction commits, retry that batch before enabling writers. A normal append after completion continues from the imported global position.

## Performance workload

From the repository root, `bun run bench:eventsourcing 10000 100` appends 10,000 events across 100 streams, reads them back and checks ordering and payloads. It uses fresh in-memory state and fixed metadata. See [the performance workflow](../../docs/performance.md) for CPU profiling and repeated comparisons. These timings describe the in-memory adapter, not SQL or broker throughput.

## Persistence failures

Storage operations preserve expected SQL, broker and stored-data failures in the typed `PersistenceError` channel, with an operation name and the original diagnostic cause. The error is exported by `@structure-ai/domain`. Aggregate loading, projections, inbox/outbox workflows and view hydration propagate it. Recover with `Effect.catchTag("PersistenceError", handler)` where the application can make a recovery decision. It is classified `permanent` to prevent automatic retries of writes whose commit status may be unknown. Defects and cancellation remain separate.

Outbox publishing retries only a single expected publish failure. A compound cause propagates unchanged, so `OutboxRelay.drain/run` also retain the publisher error type for those causes. Defects and cancellation are never treated as retryable publish failures.

## Erasing a stream (destructive retention)

When a retention policy (GDPR erasure, tenant offboarding) requires destroying the content of one aggregate stream, use `StreamEraser` — never hand-written `DELETE`s:

```ts
import { StreamEraser } from "@structure-ai/eventsourcing";
import { Effect } from "effect";

const erase = StreamEraser.pipe(
  Effect.flatMap((eraser) =>
    eraser.eraseStream({ streamName: "Conversation-42", expectedVersion: 7, reason: "gdpr-erasure ticket 1001" }),
  ),
);
```

Semantics, identical across the in-memory, SQLite, and PostgreSQL adapters:

- **Content is destroyed, order is preserved.** Every event of the stream is rewritten in place to a synthetic `Erased` tombstone: same `position` and `version`, no payload, no original metadata (correlation/causation/actor gone), only the stream identity and erasure timestamp. `readAll` stays gap-free, so projection checkpoints remain valid and catch-up continues without adjustment. Tombstones never decode into domain events — registries must not register a type named `Erased` (`ERASED_EVENT_TYPE`); decoders fail `EventDecodeError` ("unknown event type"), and `Projection` counts them `skipped`.
- **`expectedVersion` guards the race.** Like `append`: pass the stream version you observed (0 = the stream must be empty or absent). If the stream moved on, erasure fails `StreamErasureError` with reason `stream-modified` (classification `conflict`) and nothing changes; reload and retry. Malformed requests fail `invalid-request` (classification `permanent`) before any state is touched.
- **The stream is pinned forever.** The erasure ledger remembers the erased version; every later append — any `expectedVersion` — fails `ConcurrencyConflict` at that version. The erased version range can never be resurrected. Erasing a stream that never existed succeeds trivially and pins it empty.
- **Snapshots go with the content.** The stream's snapshot is deleted in the same operation (same transaction in the SQL adapters).
- **Idempotent.** Re-erasing an already-erased stream with the same `expectedVersion` rewrites nothing and returns the originally recorded outcome (`erasedEvents: 0`, original `erasedAt`/`reason`).
- **Auditable.** The ledger row (`erased_streams` in the SQL adapters) keeps the stream name, erased version, timestamp, and the caller's `reason`. The result carries the same fields back.

What erasure does **not** do: it does not touch projections that already consumed the events, outbox messages already published, or integration data downstream. Drop already-materialized read-model rows through those models' own delete paths. A projection that never saw the stream skips the tombstones. Rebuilding a projection after erasure replays tombstones (skipped), not the original content — so a rebuild never resurrects erased state.

Concurrency: append and erasure to the same stream are mutually exclusive — exactly one wins, the loser gets `ConcurrencyConflict` (append) or `stream-modified` (erasure). The PostgreSQL adapter serializes the two with a transaction-scoped advisory lock keyed on the stream name, so this holds across pool connections and processes.
>>>>>>> Stashed changes
