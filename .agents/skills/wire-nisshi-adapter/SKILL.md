---
name: wire-nisshi-adapter
description: Back a @structure-based app's event sourcing with a Nisshi (Kafka-API) broker - single-partition event topic, SQL sidecar for optimistic concurrency, snapshots, checkpoints, inbox; no outbox. Use when events should live in Nisshi instead of SQL tables.
---

# Wire the Nisshi event store

`@structure-ai/eventsourcing-nisshi` implements `EventStore`, `SnapshotStore`, `CheckpointStore`, and `Inbox` over a Nisshi broker. There is **no `Outbox`** — the event topic is the publication (ADR-0015); cross-context consumers read topics directly with `Inbox` dedupe. Everything about the design (single partition, `position = offset + 1`, sidecar ledger) is recorded in `docs/decisions/0015-nisshi-event-store.md` — read it before changing topic/partition settings.

## Steps

1. **Run a broker.** Single binary; pick the storage engine your infra already runs:

```shell
nisshi --storage-engine postgres://user:pass@host/db   # or sqlite://nisshi.db / s3://bucket/prefix
nisshi --kafka-listener-url tcp://0.0.0.0:9092 --kafka-advertised-listener-url tcp://<client-dialled-host>:9092
```

   The advertised listener must equal what the app dials — Nisshi reports it in metadata.

2. **Swap the layer** (replaces `InMemoryAll` or the SQL adapters):

```ts
import { layer, runPendingRelay } from "@structure-ai/eventsourcing-nisshi";

const stores = layer({
  brokerUrl: settings.brokerUrl,   // tcp://host:9092
  filename: "./sidecar.db",        // sqlite sidecar for the ledger/snapshots/checkpoints/inbox
  topic: "events",                 // single partition; created and verified at start
});
```

   On an existing `SqlClient` + `NisshiClient`: `storesLayer(options)`; run `migrate(options)` once first.

3. **Run the orphan relay** in a worker (or every instance — it is idempotent): `Effect.runFork(runPendingRelay({ pollInterval: 500 }))`. It re-produces events whose append crashed between ledger reservation and broker ack.

4. **Cross-context integration without the outbox**: other contexts consume the event topic as a projection (checkpoint via `CheckpointStore`), deduplicating by `(streamName, version)` through `Inbox.dedupe`. External side effects (email, webhooks) are consumers with retries — not outbox entries.

5. **Optional schema files**: `writeSchemaFiles(dir, [topic])` generates the JSON Schema for the envelope; mount via `--schema-registry file://./dir` (relative path only). Broker-side enforcement does not engage on Nisshi v0.7.0-pre.2 — client-side envelope validation is on by default (`schemaValidation`).

## Rules

- Never create the events topic with more than **one partition** — `position` semantics and every checkpoint depend on the total order (ADR-0015).
- Keep infinite retention, no compaction: the topic is the raw history; snapshots are only a cache.
- Do not probe for the topic's existence via metadata before creating it — Nisshi auto-creates probed topics with four partitions; the layer creates-then-verifies for you.
- Tests need a broker: they skip unless `NISSHI_URL` is set (CI installs a pinned release). Local: `nisshi --storage-engine memory://t/` and export the listener.
