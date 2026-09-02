# @structure-ai/migrations

Versioned, ordered, forward-only SQL migrations on `@effect/sql`'s Migrator. Dialect-agnostic: the package depends only on `@effect/sql`, and apps provide whichever `SqlClient` layer they already use (`@effect/sql-sqlite-bun`, `@effect/sql-pg`, ...). Applied migrations are recorded in a bookkeeping table with a per-migration checksum; concurrent runners are lock-protected, so a second runner either fails or waits — it never double-applies.

There is no `down`: per the delivery policy, irreversible changes roll forward with a new migration, never a rollback. Each `run` invocation is one transaction — if any migration in the batch fails, the whole batch rolls back (all-or-nothing), and the failure surfaces as a fatal defect rather than a recoverable error.

## Usage

```ts
import * as SqlClient from "@effect/sql/SqlClient";
import { defineMigration, layer, makeSet, run } from "@structure-ai/migrations";
import { Effect } from "effect";

const createUsers = "CREATE TABLE users (id TEXT PRIMARY KEY)";
const migrations = makeSet([
  defineMigration(1, "create_users",
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(createUsers)).pipe(Effect.asVoid),
    { sql: createUsers }), // declared SQL → the checksum covers the content
  defineMigration(2, "add_email",
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql`ALTER TABLE users ADD COLUMN email TEXT`)),
]);

// explicit run (deploy job, single writer's startup):
const applied = yield* run(migrations);
// replicas that boot together: block for the lock, then verify or apply
const MigrateLayer = layer(migrations, { lock: "session", waitFor: "2 minutes" });
```

CLI integration (subpath export, pairs with `@structure-ai/cli`):

```ts
import { migrationsCommand } from "@structure-ai/migrations/cli";
// <app> migrations up | <app> migrations status
const cmd = migrationsCommand(migrations);
```

Serving instances that must never migrate register the readiness probe instead:

```ts
import { migrationsReadinessCheck } from "@structure-ai/migrations";
import { Readiness } from "@structure-ai/runtime";

const readiness = yield* Readiness;
yield* readiness.register(yield* migrationsReadinessCheck(migrations));
```

## Checksums and drift

`defineMigration` computes a sha-256 checksum over the migration's declared identity — `id`, `name`, and the `sql` option when given (`up` is an opaque Effect and cannot be hashed). The checksum is recorded when the migration runs and compared on every `status` and `run`:

- **`unknown`** — a recorded id that is not in the set: the database was migrated by a newer artifact than the running one (e.g. rollback after a forward migration). The database is ahead; this build must not serve or migrate it.
- **`mismatched`** — the recorded checksum differs from the set's: the migration was edited or renamed after it ran. Declare `sql` to catch content edits; without it only id/name changes are detected.

`run` is fail-closed: after taking the lock it re-reads the history and fails with `MigrationError("bad-state")` on either condition before applying anything. `status` reports both without touching the schema; `migrations status` exits non-zero on them.

Existing installs: the `checksum` column is added idempotently by the first `run` after upgrading, and rows recorded before it existed adopt the current checksums (they are never reported as mismatched). `status` reads such tables without altering them.

## Locking

| `lock` | Postgres | Other dialects (sqlite) |
| --- | --- | --- |
| `"transaction"` (default) | Non-blocking `pg_try_advisory_xact_lock`; a concurrent runner fails at once with `MigrationError("locked")`. | The upstream bookkeeping insert (and sqlite's write lock) detects the concurrent runner → `locked`. |
| `"session"` | Blocking `pg_advisory_lock` on a dedicated connection, bounded by `waitFor` via `lock_timeout` (default 30 s; an infinite `Duration` waits without bound). Once acquired the history is re-read, so a waiter with nothing left to do ends green with `[]`. Timeout → `locked`. | Emulated: the non-blocking path is retried every 100 ms until `waitFor` elapses, then `locked`. |

Both modes lock the same key, so mixed-mode runners exclude each other. Use `"transaction"` where a deploy step owns the retry; use `"session"` where several replicas boot together and each must end in the same verified state.

## Exports

| Export | What it is |
| --- | --- |
| `defineMigration(id, name, up, { sql? })` | One forward migration; `up` is an Effect using `SqlClient`. Ids are integers ≥ 1, ordered. `sql` (string or statements) is hashed into the `checksum`. |
| `migrationChecksum(id, name, sql?)` | The checksum `defineMigration` records: sha-256 over `JSON.stringify([id, name, statements])`. |
| `makeSet(migrations)` | Validates (unique ids, listing every problem) and orders the set. |
| `run(set, { table?, lock?, waitFor? })` | Applies pending migrations in order; returns the `[id, name]` pairs applied. Creates the bookkeeping table (and its `checksum` column) when missing. Fails with `MigrationError` — `locked` (see Locking), `bad-state` (unknown/mismatched history), `failed`, ... |
| `layer(set, options?)` | Runs migrations during layer construction — include it only in the process explicitly allowed to migrate. |
| `status(set, { table? })` | `{ applied, pending, unknown, mismatched }` report, read-only; a missing bookkeeping table reads as nothing applied. |
| `inconsistencies(report)` | The `unknown`/`mismatched` entries of a report as human-readable lines (empty when the history matches). |
| `migrationsReadinessCheck(set, { table?, name? })` | Resolves the `SqlClient` and returns `{ name, run: Effect<boolean> }` — ready only with nothing pending, unknown or mismatched; probe errors answer not ready. Structurally a `@structure-ai/runtime` `ReadinessCheck` (no runtime dependency). |
| `MigrationError` | Re-export of `@effect/sql/Migrator`'s error (`reason: "locked" \| "bad-state" \| "failed" \| ...`). |
| `migrationsCommand(set, options?)` (from `./cli`) | Ready-made `migrations up` / `migrations status` command group; `status` exits non-zero on unknown/mismatched rows. |

For incompatible schema changes follow expand → migrate/backfill → switch readers/writers → contract, each step its own migration.
