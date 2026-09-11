# @structure-ai/eventsourcing-sqlite

SQLite adapters (`bun:sqlite` through `@effect/sql-sqlite-bun`) for the `@structure-ai/eventsourcing` ports: `EventStore`, `SnapshotStore`, `CheckpointStore`, `Outbox`, and `Inbox`, with transactional append + outbox. The single-process durable shape: local tools, tests that need a real file, small deployments on one node.

## Usage

```ts
import { layer } from "@structure-ai/eventsourcing-sqlite";

// One layer: a bun:sqlite SqlClient for the file, migration at build, every adapter.
const durable = layer({ filename: "./data/events.sqlite" });
// `":memory:"` for tests.
```

On an existing `SqlClient`: `storesLayer(options)` merges every adapter; run `migrate(options)` yourself first, once. Individual adapters — `eventStoreLayer`, `snapshotStoreLayer`, `checkpointStoreLayer`, `outboxLayer`, `inboxLayer` — compose the same way.

## Exports

| Export | What it is |
| --- | --- |
| `layer(config)` | `SqliteClient` for `filename` (WAL on unless `disableWAL`) + `migrate` + every adapter, and the client itself. |
| `storesLayer(options?)` | Every adapter on top of an ambient `SqlClient` (no migration). |
| `migrate(options?)` | Idempotent `CREATE TABLE IF NOT EXISTS` for events, snapshots, checkpoints, outbox (with the `available_at` schedule column — added in place for existing databases), and inbox, prefixed by `tablePrefix`, plus the expression index on the envelope's partition (`json_extract(metadata, '$.partition')`, `position`) that serves `readAll({ partition })`; an existing database gets the index at the next `migrate`. |
| `tableNames(options?)` | Resolved table names for a prefix — use it for test isolation and cleanup. |
| `appendWithOutbox(stream, expectedVersion, events, messages)` | Events and outbox rows committed in one transaction. |
| `AdapterOptions` | `tablePrefix` (default none). |

## Partition filter

`readAll({ partition })` filters on `json_extract(metadata, '$.partition')`, the exact expression the index in `migrate` covers, so the planner uses it (`EXPLAIN QUERY PLAN` shows the index for a single value). The envelope stays the single source of truth; there is no stored column, because SQLite cannot add a stored generated column to an existing table and has no idempotent add-column form. Events without a partition never match. See [ADR-0018](../../docs/decisions/0018-partition-on-the-event-envelope.md).

## Notes

- A lost append race surfaces as `ConcurrencyConflict` from the `UNIQUE(stream_name, version)` backstop, with the actual version re-read after rollback.
- Positions are the `INTEGER PRIMARY KEY AUTOINCREMENT` rowids: global, monotonic, visible in commit order under SQLite's single writer.
- No `HistoryImporter` and no `IdempotencyStore` here; use `@structure-ai/eventsourcing-pg` for those.
