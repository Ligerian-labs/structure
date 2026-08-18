# ADR-0006: View models are a query-side mapper, deliberately not a general ORM

- Status: accepted
- Date: 2026-08-18

## Context

The query side of CQRS needs typed, queryable read models. General ORMs (relations, lazy loading, change tracking, identity maps) optimize for a shared read/write model — exactly the shape this architecture forbids.

## Decision

`@structure-ai/viewmodel` maps one Schema-defined view model to one table: typed store (`get`/`find`/`upsert`/`patch`/`remove`/`truncate`), generated DDL entering the normal migration set, and hydration exclusively via event projections (`ViewProjection`). No relations, no joins API, no change tracking. Each table has exactly one writer: its projection.

## Consequences

- Read models stay denormalized, per-consumer, and disposable — `rebuild` (truncate + replay with `live: false`) is the universal repair for any view corruption or shape change.
- Needing a join across view models is a signal to define a new view model shaped for that consumer, not to add a relations API.
- `patch` is read-merge-write and intentionally non-atomic: safe under the single-writer rule, wrong if that rule is broken.
- Storage classes are derived from the schema AST with pg-valid types so the same definition works on sqlite and Postgres; complex fields serialize to JSON text rather than growing a type-mapping DSL.
