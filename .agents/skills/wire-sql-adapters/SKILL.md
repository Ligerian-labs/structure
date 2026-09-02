---
name: wire-sql-adapters
description: Replace in-memory event-sourcing adapters with durable SQLite or PostgreSQL ones in a @structure-based app. Use when an app needs persistent events, snapshots, checkpoints, outbox, or inbox.
---

# Wire durable SQL adapters

The same five ports (`EventStore`, `SnapshotStore`, `CheckpointStore`, `Outbox`, `Inbox`) ship in-memory for tests; `@structure-ai/eventsourcing-sqlite` (bun:sqlite) and `-pg` (`@effect/sql-pg`) swap them for durable storage without touching domain code. Behavior parity across adapters is enforced by running the same scenarios (`packages/<adapter>/test/scenarios.ts`) against each; `-pg` additionally ships the durable `@structure-ai/cqrs` `IdempotencyStore` (`packages/eventsourcing-pg/README.md`).

## Steps

1. **Replace `InMemoryAll` with the adapter layer** — everything-in-one, migration runs at layer build:

```ts
import { layer } from "@structure-ai/eventsourcing-sqlite";
// pg: import { layer } from "@structure-ai/eventsourcing-pg";

const durable = layer({ filename: "./app.db" });            // sqlite
// pg: layer({ url: fromSettings }) via your SqlClient config
```

   On an existing `SqlClient` (shared with view models/migrations): `storesLayer(options)` — run `migrate(options)` yourself first, once, in the designated migration process.

2. **Use `tableNames({ tablePrefix })`** to namespace tables (`events`, `snapshots`, `checkpoints`, `outbox`, `inbox`, and on pg `idempotency` per prefix) — required for pg test isolation, available for multi-app databases.
   - pg: `layer`/`storesLayer` also provide the cqrs `IdempotencyStore` (`idempotencyTtl`, default 24 hours) — provide it to `CommandBus.layer` instead of `IdempotencyStore.inMemory`, and run `purgeExpiredIdempotency(options)` on a schedule.
3. **Transactional outbox**: prefer `appendWithOutbox(stream, expectedVersion, events, messages)` — events + outbox rows commit in one transaction, so a crash between "decided" and "notified" is impossible.
4. **Wire `OutboxRelay.run`** in a worker (or every instance, if cheap): pending → publish → mark, exponential backoff with jitter, dead letters after `maxAttempts` with the last error kept.
5. **Tests:** sqlite via `layer({ filename: ":memory:" })` — same scenarios as in-memory; pg tests must skip unless `DATABASE_URL` is set (see `packages/eventsourcing-pg/test/pg.test.ts`: unique table prefix per run, tables dropped after).

## Rules

- One migration owner: either the adapter's `layer` (build-time migrate) or your `@structure-ai/migrations` set via `migrate` — never both racing. When the app has a set, every package-owned schema goes in it: `defineMigration(id, name, migrate(options))` for eventsourcing-pg/jobs, `migration(id, options)` from `@structure-ai/auth-pg` for the auth tables (its Bun `SQL` `migrate(sql)` is the no-set alternative, same DDL).
- Adapter choice is deployment shape, not domain concern: domain code depends only on `@structure-ai/eventsourcing` ports; only the composition root names the adapter package.
- WAL is on by default for sqlite files; `:memory:` needs no WAL.
- Dead-lettered outbox messages are data: surface them (queue depth, alert) — the relay never silently drops.

## Verify

`bun x tsc --noEmit && bun test` in the package (pg suite runs only with `DATABASE_URL`).
