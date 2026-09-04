# @structure-ai/eventsourcing-pg

PostgreSQL adapters (`@effect/sql-pg`) for the `@structure-ai/eventsourcing` ports, including `EventStore`, `HistoryImporter`, snapshots, checkpoints, outbox, and inbox, plus a durable `IdempotencyStore` for `@structure-ai/cqrs`.

## Usage

```ts
import { layer } from "@structure-ai/eventsourcing-pg";
import { CommandBus } from "@structure-ai/cqrs";
import { Layer } from "effect";

// One layer: PgClient from `url` (or DATABASE_URL), migration at build, every adapter.
const durable = layer({ url: databaseUrl, idempotencyTtl: "24 hours" });

// The command bus takes its IdempotencyStore from the same layer.
const bus = CommandBus.layer.pipe(Layer.provide(Layer.mergeAll(handlers, authorizer, durable)));
```

On an existing `SqlClient` (shared with view models and migrations): `storesLayer(options)` merges every adapter; run `migrate(options)` yourself first, once, from the designated migration process. Individual adapters — `eventStoreLayer`, `snapshotStoreLayer`, `checkpointStoreLayer`, `outboxLayer`, `inboxLayer`, `idempotencyStoreLayer` — compose the same way.

## Exports

| Export | What it is |
| --- | --- |
| `layer(config?)` | `PgClient` + `migrate` + every adapter, and the client itself. `config`: `url`, `maxConnections`, `applicationName`, plus the adapter options. |
| `storesLayer(options?)` | Every adapter on top of an ambient `SqlClient` (no migration). |
| `migrate(options?)` | Idempotent `CREATE TABLE IF NOT EXISTS` for events, history-import bookkeeping, snapshots, checkpoints, outbox, inbox, and idempotency tables, all prefixed by `tablePrefix`. |
| `tableNames(options?)` | Resolved table names for a prefix — use it for test isolation and cleanup. |
| `appendWithOutbox(stream, expectedVersion, events, messages)` | Events and outbox rows committed in one transaction. |
| `HistoryImporter` from `eventStoreLayer`/`storesLayer` | Preserves frozen source positions and versions in atomic, resumable batches. Import bookkeeping makes identical retries no-ops and rejects divergence. |
| `idempotencyStoreLayer(options?)` | `@structure-ai/cqrs` `IdempotencyStore` over the `idempotency` table. |
| `purgeExpiredIdempotency(options?)` | Deletes idempotency records past their TTL; returns the count. |
| `AdapterOptions` | `tablePrefix` (default none) and `idempotencyTtl` (default 24 hours). |

## Idempotency store

One row per `(tag, actor, key)` claim; the anonymous scope is stored as the empty actor. `begin` is a single conditional upsert (insert a fresh claim, or replace an expired one) followed, when a live record exists, by a read that reports `Completed` (with the JSON result), `InFlight` or `Mismatch` — so concurrent `begin` calls for one context yield exactly one `Claimed`, across instances. `complete` stores the encoded success and refreshes `expires_at`; `release` deletes a claim that never completed.

Records expire `idempotencyTtl` after their last claim or completion: `begin` treats an expired record as absent — it reclaims the row in place (whatever its old payload hash or status), and the reclaimed row is live again — and `purgeExpiredIdempotency` deletes the rows still expired when it runs, returning exactly that count. Size the TTL to the callers' retry window. A claim left by a crashed process blocks its key (callers see `IdempotencyInFlight`, 409) until it expires — bound handlers with a dispatch `timeout` so claims are released on the normal path. Run the purge periodically from any instance; it is safe to run concurrently.

## Commit order

`position` is drawn from a sequence at insert time, inside the append transaction, so two concurrent appends could commit in the opposite order of their positions; a projection polling in between would checkpoint past a position whose transaction had not committed yet and never deliver that event (it is committed, visible to `read`, and replayed by a rebuild — the live view and the rebuilt view diverge silently). `EventStore.append` and `appendWithOutbox` therefore take a transaction-scoped advisory lock (`pg_advisory_xact_lock(0x5f455654, hashtext(<events table>))`) after the version check and before the first insert; Postgres releases it as part of the commit, after the transaction is visible to new snapshots, so positions become visible in the order they were drawn and a reader that has seen position N has seen every committed event below it. Only the inserts and the commit are serialized, never the version check or the caller's own work, and an empty (version-checked) append takes no lock. Measured on a local Postgres 17: a single writer is unchanged (about 2 ms per two-event append); sixteen concurrent writers go from about 2,600 to about 600 appends per second, the serialized section costing about 1.6 ms per append. Keep that advisory key for this package; `HistoryImporter` locks the events table exclusively and composes with it.

## Tests

`bun test` runs the suite against `DATABASE_URL` and skips it otherwise. Each test creates a uniquely prefixed table set and drops it afterwards, so one database serves parallel runs.
