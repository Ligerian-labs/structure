# @structure-ai/eventsourcing-pg

PostgreSQL adapters (`@effect/sql-pg`) for the five `@structure-ai/eventsourcing` ports — `EventStore`, `SnapshotStore`, `CheckpointStore`, `Outbox`, `Inbox` — plus a durable `IdempotencyStore` for `@structure-ai/cqrs`. Behavior matches the in-memory implementations (the behavioral spec): the same scenario suite runs against both.

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
| `migrate(options?)` | Idempotent `CREATE TABLE IF NOT EXISTS` for all tables: `events`, `snapshots`, `checkpoints`, `outbox`, `inbox`, `idempotency` (prefixed by `tablePrefix`). |
| `tableNames(options?)` | Resolved table names for a prefix — use it for test isolation and cleanup. |
| `appendWithOutbox(stream, expectedVersion, events, messages)` | Events and outbox rows committed in one transaction. |
| `idempotencyStoreLayer(options?)` | `@structure-ai/cqrs` `IdempotencyStore` over the `idempotency` table. |
| `purgeExpiredIdempotency(options?)` | Deletes idempotency records past their TTL; returns the count. |
| `AdapterOptions` | `tablePrefix` (default none) and `idempotencyTtl` (default 24 hours). |

## Idempotency store

One row per `(tag, actor, key)` claim; the anonymous scope is stored as the empty actor. `begin` is a single conditional upsert (insert a fresh claim, or replace an expired one) followed, when a live record exists, by a read that reports `Completed` (with the JSON result), `InFlight` or `Mismatch` — so concurrent `begin` calls for one context yield exactly one `Claimed`, across instances. `complete` stores the encoded success and refreshes `expires_at`; `release` deletes a claim that never completed.

Records expire `idempotencyTtl` after their last claim or completion: `begin` treats an expired record as absent — it reclaims the row in place (whatever its old payload hash or status), and the reclaimed row is live again — and `purgeExpiredIdempotency` deletes the rows still expired when it runs, returning exactly that count. Size the TTL to the callers' retry window. A claim left by a crashed process blocks its key (callers see `IdempotencyInFlight`, 409) until it expires — bound handlers with a dispatch `timeout` so claims are released on the normal path. Run the purge periodically from any instance; it is safe to run concurrently.

## Tests

`bun test` runs the suite against `DATABASE_URL` and skips it otherwise. Each test creates a uniquely prefixed table set and drops it afterwards, so one database serves parallel runs.
