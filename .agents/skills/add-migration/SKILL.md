---
name: add-migration
description: Add a database schema migration in a @structure-based app. Use for any table/column/index change or data backfill.
---

# Add a migration

Migrations are forward-only, integer-ordered, and each `run` invocation is one transaction (all-or-nothing). There is no `down` — irreversible changes roll forward with a new migration. Each migration records a sha-256 checksum of its declared identity (`id`, `name`, declared `sql`); `run`, `status` and the readiness check compare the database's history against the build by checksum. Reference: `packages/migrations/README.md`.

## Steps

1. **Pick the next id** — highest existing id in the app's `makeSet([...])` plus one. Never renumber or edit an already-applied migration; ship a new one instead (an edit is reported as `mismatched` and blocks every later run).
2. **Define it, declaring the SQL** so the checksum covers the content, not just id and name:

```ts
import * as SqlClient from "@effect/sql/SqlClient";
import { defineMigration } from "@structure-ai/migrations";
import { Effect } from "effect";

const sql = "ALTER TABLE invoices ADD COLUMN due_date TEXT";
export const addInvoiceDueDate = defineMigration(7, "add_invoice_due_date",
  Effect.flatMap(SqlClient.SqlClient, (client) => client.unsafe(sql)).pipe(Effect.asVoid),
  { sql },
);
```

For a new view-model table use `ViewModel.migration(def, id)` from `@structure-ai/viewmodel` instead of hand-written DDL (it declares its generated DDL). A migration whose `up` is not expressible as static SQL (a backfill computed in code) may omit `sql`; its checksum then covers only `id` and `name`.

3. **Add it to the set** and keep DDL portable (pg-valid types; sqlite accepts anything): `TEXT`, `INTEGER`, `DOUBLE PRECISION`, `BOOLEAN`, `BIGINT`.
4. **Incompatible changes** follow expand → migrate/backfill → switch readers/writers → contract — each step its own migration, backfills bounded and re-runnable.
5. **Run it** where the deployment policy allows: `<app> migrations up` (CLI group via `migrationsCommand(set)` from `@structure-ai/migrations/cli`), or `layer(set)` in the one process permitted to migrate. Replicas that boot together use `layer(set, { lock: "session", waitFor: "2 minutes" })` — one applies, the others wait and verify. `migrations status` shows `applied`/`pending`/`unknown`/`mismatched` and exits non-zero on the last two.
6. **Guard serving instances** that never migrate: `readiness.register(yield* migrationsReadinessCheck(set))` keeps `/health/ready` at 503 while anything is pending, unknown (database ahead of this build) or mismatched.
7. **Test:** extend the app's migration test — fresh sqlite `:memory:`, `run(set)`, assert the new shape; plus a second `run` proving idempotence. Follow `packages/migrations/test/migrations.test.ts`.

## Rules

- Applied migrations are immutable history; fixing a mistake = a new migration. Whitespace counts: the declared `sql` is hashed byte-exact.
- Concurrent runners are lock-protected. `lock: "transaction"` (default): the second fails with `MigrationError("locked")` — don't retry in a loop, let the deploy step own it. `lock: "session"`: the second blocks up to `waitFor`, then verifies; a timeout is `locked`.
- A database ahead of the build (`unknown` rows, e.g. after a rollback) is refused, never silently accepted: roll forward, don't touch the bookkeeping table.
- Never branch DDL on environment names.

## Verify

`bun x tsc --noEmit && bun test` in the package.
