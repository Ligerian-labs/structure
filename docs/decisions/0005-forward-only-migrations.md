# ADR-0005: Forward-only, all-or-nothing migrations

- Status: accepted
- Date: 2026-08-18

## Context

Schema evolution needs ordering, bookkeeping, and concurrency safety. Down-migrations promise a rollback that is a lie for any migration that destroyed or transformed data.

## Decision

`@structure-ai/migrations` wraps `@effect/sql`'s Migrator: integer-ordered, in-code Effect migrations, recorded in a bookkeeping table, lock-protected against concurrent runners. No `down` — mistakes roll forward as new migrations. Each `run` invocation executes in one transaction: a failing migration rolls back the whole batch. The package is dialect-agnostic (depends only on `@effect/sql`); apps bring their own `SqlClient` layer.

## Consequences

- Applied migrations are immutable history; the "fix" path is always another migration, matching the delivery policy (expand → backfill → switch → contract).
- All-or-nothing batches mean a deploy either fully migrates or leaves the schema untouched — no half-applied states to diagnose.
- Individual migration failures surface as fatal defects, not recoverable errors: a failed migration is a stopped deployment by design.
- Which process may migrate is an explicit deployment decision (CLI command, deploy job, or single-writer startup layer) — never every instance.
