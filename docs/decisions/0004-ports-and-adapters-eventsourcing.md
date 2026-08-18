# ADR-0004: Event-sourcing ports in core, SQL adapters as separate packages, transactional outbox

- Status: accepted
- Date: 2026-08-18

## Context

Event sourcing needs durable storage, but coupling the core package to a database would force every consumer to carry SQL dependencies, and cross-context messaging needs atomic publication with state changes.

## Decision

`@structure/eventsourcing` defines the ports (`EventStore`, `SnapshotStore`, `CheckpointStore`, `Outbox`, `Inbox`) plus in-memory implementations; durable adapters ship as separate packages (`-sqlite` on `bun:sqlite`, `-pg` on `@effect/sql-pg`) implementing the identical observable behavior — the core package's tests are the behavioral spec. Appends are transactional with optimistic concurrency (`UNIQUE(stream_name, version)` as the race backstop), and `appendWithOutbox` writes events + outbox rows in one transaction.

## Consequences

- Tests run on in-memory ports; production swaps a layer. Delivery semantics (at-least-once, checkpoint-per-batch, dead letters after bounded retries) are identical across adapters.
- Exactly-once business effects come from expected-version appends + inbox dedup, never from transport claims.
- Each new database is a new adapter package implementing five ports against the existing scenario suite.
- Postgres correctness is only proven when `DATABASE_URL` is present — CI runs that suite against a real Postgres service.
