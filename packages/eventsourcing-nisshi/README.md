# @structure-ai/eventsourcing-nisshi

[Nisshi](https://github.com/nisshi-io/nisshi) (Kafka-API compatible broker) as the event store, with a small SQL sidecar (SQLite or PostgreSQL via `@effect/sql`) for everything a log cannot do on its own: optimistic concurrency, snapshots, checkpoints, and inbox dedupe.

Implements **four** ports: `EventStore`, `SnapshotStore`, `CheckpointStore`, `Inbox`. There is **no `Outbox`** by design — see [ADR-0015](../../docs/decisions/0015-nisshi-event-store.md): the event topic itself is the publication; cross-context consumers read it directly and dedupe via `Inbox`.

## How it works

- **Events** live in one single-partition topic (default `events`), key = stream name, value = a JSON envelope `{type, schemaVersion, version, payload, metadata}`. Infinite retention, no compaction — the topic *is* the raw history.
- **Positions** are Kafka offsets + 1 — a true global total order (single partition).
- **Optimistic concurrency** via the sidecar ledger: `append(stream, expectedVersion, events)` reserves `expectedVersion+1..n` in one SQL transaction (conditional UPDATE / unique INSERT), produces with `acks=all`, then confirms. A lost race fails with `ConcurrencyConflict` before anything is written. A crash between reservation and produce leaves pending rows that `drainPending` re-produces (at-least-once; readers dedupe by `(stream, version)`).
- **Snapshots / checkpoints / inbox** are sidecar tables (pure cache and dedupe state; losing them costs performance, never correctness).
- **Protocol**: an in-package minimal Kafka wire client (no runtime dependencies) pinned to non-flexible API versions — `Produce` v3, `Fetch` v4, `Metadata` v0, `CreateTopics` v4 — negotiated and verified at connect. No consumer groups, no transactions: reads are positioned fetches, progress tracking is the sidecar checkpoint.

## Usage

SQLite sidecar:

```ts
import { layer, runPendingRelay } from "@structure-ai/eventsourcing-nisshi";

const durable = layer({
  brokerUrl: "tcp://127.0.0.1:9092", // must equal the broker's advertised listener
  filename: "./sidecar.db",           // ":memory:" for tests
  topic: "events",                    // single partition, created when missing
});
```

PostgreSQL sidecar:

```ts
import { layerPg } from "@structure-ai/eventsourcing-nisshi";

const durable = layerPg({
  brokerUrl: "tcp://127.0.0.1:9092",
  url: "postgres://app:secret@db:5432/app", // defaults to DATABASE_URL
  applicationName: "orders",
  maxConnections: 10,
  topic: "events",
});
```

On an existing SQLite or PostgreSQL `SqlClient` plus `NisshiClient`, use `storesLayer(options)` and run `migrate(options)` first.

Run the orphan relay in a worker (or every app instance, it is idempotent):

```ts
Effect.runFork(runPendingRelay({ pollInterval: 500 }));
```

## Options

| Option | Default | Notes |
| --- | --- | --- |
| `brokerUrl` | — | Broker listener; must match `--kafka-advertised-listener-url`. |
| `filename` (`layer`) | — | Sidecar SQLite file (`":memory:"` works). |
| `url` (`layerPg`) | `DATABASE_URL` / libpq defaults | Sidecar PostgreSQL connection URL. |
| `applicationName` / `maxConnections` (`layerPg`) | driver defaults | PostgreSQL pool options. |
| `topic` | `"events"` | Must have exactly one partition (verified; ADR-0015). |
| `createTopic` | `true` | Create the topic at layer start when missing. |
| `schemaValidation` | `true` | Validate envelopes client-side before produce. |
| `tablePrefix` | — | Namespace sidecar tables. |

## Schema files (broker-side validation, forward path)

`writeSchemaFiles(dir, topics)` writes one JSON Schema (`<topic>.json`) per topic describing the envelope. Mount the directory with the broker's `--schema-registry file://./<dir>` (relative paths only — Nisshi collapses leading slashes). Note: broker-side enforcement did **not** engage on Nisshi v0.7.0-pre.2 (its own CLI accepts records violating its own sample schemas); client-side validation is the effective guard until a Nisshi release enforces it.

## Production topologies

The **sidecar** may be SQLite (`layer`) or PostgreSQL (`layerPg`). Use PostgreSQL when multiple app instances can command the same aggregate: the concurrency ledger must be shared. A process-local SQLite sidecar is only safe for a single writer instance.

Separately, Nisshi backs the broker with pluggable storage:

- **PostgreSQL** — `nisshi --storage-engine postgres://user:pass@host:5432/db`
- **S3-compatible** — `nisshi --storage-engine s3://bucket/prefix` (11-nines durability class)
- **libSQL/SQLite** — `nisshi --storage-engine sqlite://nisshi.db` (single host)

The sidecar and broker storage may share one PostgreSQL server, but use separate schemas/credentials and backup policies. Run one broker process per availability need — brokers are stateless, all are leaders; durability comes from the storage engine, not broker replication. Set `--kafka-advertised-listener-url` to the address clients dial.

## Tests

`bun test` skips broker suites unless `NISSHI_URL` is set; PostgreSQL-sidecar scenarios additionally require `DATABASE_URL`. CI installs a pinned Nisshi release, starts PostgreSQL, and runs both sidecar suites. The wire quirks this client encodes (trailing `throttle_time_ms` in Produce, metadata-triggered topic auto-creation, empty-topic high watermark of 1, whole-batch fetch granularity) are pinned by tests in `test/protocol.test.ts`.
