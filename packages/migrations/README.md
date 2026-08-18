# @structure/migrations

Versioned, ordered, forward-only SQL migrations on `@effect/sql`'s Migrator. Dialect-agnostic: the package depends only on `@effect/sql`, and apps provide whichever `SqlClient` layer they already use (`@effect/sql-sqlite-bun`, `@effect/sql-pg`, ...). Applied migrations are recorded in a bookkeeping table; concurrent runners are lock-protected, so a second runner fails instead of double-applying.

There is no `down`: per the delivery policy, irreversible changes roll forward with a new migration, never a rollback. Each `run` invocation is one transaction — if any migration in the batch fails, the whole batch rolls back (all-or-nothing), and the failure surfaces as a fatal defect rather than a recoverable error.

## Usage

```ts
import * as SqlClient from "@effect/sql/SqlClient";
import { defineMigration, layer, makeSet, run } from "@structure/migrations";
import { Effect } from "effect";

const migrations = makeSet([
  defineMigration(1, "create_users",
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql`CREATE TABLE users (id TEXT PRIMARY KEY)`)),
  defineMigration(2, "add_email",
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql`ALTER TABLE users ADD COLUMN email TEXT`)),
]);

// explicit run (deploy job, single writer's startup):
const applied = yield* run(migrations);
// or as a layer in the ONE process allowed to migrate:
const MigrateLayer = layer(migrations);
```

CLI integration (subpath export, pairs with `@structure/cli`):

```ts
import { migrationsCommand } from "@structure/migrations/cli";
// <app> migrations up | <app> migrations status
const cmd = migrationsCommand(migrations);
```

## Exports

| Export | What it is |
| --- | --- |
| `defineMigration(id, name, up)` | One forward migration; `up` is an Effect using `SqlClient`. Ids are integers ≥ 1, ordered. |
| `makeSet(migrations)` | Validates (unique ids, listing every problem) and orders the set. |
| `run(set, { table? })` | Applies pending migrations in order; returns the `[id, name]` pairs applied. Fails with the library's `MigrationError` (`locked`, `failed`, ...). |
| `layer(set, options?)` | Runs migrations during layer construction — include it only in the process explicitly allowed to migrate. |
| `status(set, options?)` | `{ applied, pending }` report; a missing bookkeeping table reads as nothing applied. |
| `migrationsCommand(set, options?)` (from `./cli`) | Ready-made `migrations up` / `migrations status` command group. |

For incompatible schema changes follow expand → migrate/backfill → switch readers/writers → contract, each step its own migration.
