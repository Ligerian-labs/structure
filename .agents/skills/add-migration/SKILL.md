---
name: add-migration
description: Add a database schema migration in a @structure-based app. Use for any table/column/index change or data backfill.
---

# Add a migration

Migrations are forward-only, integer-ordered, and each `run` invocation is one transaction (all-or-nothing). There is no `down` — irreversible changes roll forward with a new migration. Reference: `packages/migrations/README.md`.

## Steps

1. **Pick the next id** — highest existing id in the app's `makeSet([...])` plus one. Never renumber or edit an already-applied migration; ship a new one instead.
2. **Define it:**

```ts
import * as SqlClient from "@effect/sql/SqlClient";
import { defineMigration } from "@structure-ai/migrations";
import { Effect } from "effect";

export const addInvoiceDueDate = defineMigration(7, "add_invoice_due_date",
  Effect.flatMap(SqlClient.SqlClient, (sql) => sql`ALTER TABLE invoices ADD COLUMN due_date TEXT`),
);
```

For a new view-model table use `ViewModel.migration(def, id)` from `@structure-ai/viewmodel` instead of hand-written DDL.

3. **Add it to the set** and keep DDL portable (pg-valid types; sqlite accepts anything): `TEXT`, `INTEGER`, `DOUBLE PRECISION`, `BOOLEAN`, `BIGINT`.
4. **Incompatible changes** follow expand → migrate/backfill → switch readers/writers → contract — each step its own migration, backfills bounded and re-runnable.
5. **Run it** where the deployment policy allows: `<app> migrations up` (CLI group via `migrationsCommand(set)` from `@structure-ai/migrations/cli`), or `layer(set)` in the one process permitted to migrate. `migrations status` shows applied/pending.
6. **Test:** extend the app's migration test — fresh sqlite `:memory:`, `run(set)`, assert the new shape; plus a second `run` proving idempotence. Follow `packages/migrations/test/migrations.test.ts`.

## Rules

- Applied migrations are immutable history; fixing a mistake = a new migration.
- Concurrent runners are lock-protected: the second fails with `MigrationError("locked")` — don't retry in a loop, let the deploy step own it.
- Never branch DDL on environment names.

## Verify

`bun x tsc --noEmit && bun test` in the package.
