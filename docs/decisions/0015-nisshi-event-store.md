# ADR-0015: Nisshi event store — single partition, sidecar ledger, collapsed outbox

- Status: accepted
- Date: 2026-09-02

## Context

`@structure-ai/eventsourcing` defines its `EventStore` port with three guarantees: per-stream optimistic concurrency (`expectedVersion` CAS failing with `ConcurrencyConflict`), a global total order (`position`) consumed by projections, and indefinite per-stream replay. We want to back these with [Nisshi](https://github.com/nisshi-io/nisshi) — a stateless, Kafka-API compatible single-binary broker with pluggable storage (PostgreSQL, S3, SQLite) — to run event-sourced services on storage infrastructure teams already operate, without broker-replication fleets.

The Kafka protocol provides none of the three guarantees directly: no conditional produce, offsets are per-partition, and there is no key index for stream reads. We verified the wire behavior empirically against Nisshi v0.7.0-pre.2 with an in-repo protocol client (no external Kafka dependency exists in the repository).

## Decision

1. **Single-partition topic per event topic, forever.** Offsets then form the global total order; `position = offset + 1`. `readAll` and `CheckpointStore` keep their exact one-bigint contract. Partitioning for throughput is explicitly deferred (see consequences).
2. **Optimistic concurrency lives in a SQL sidecar ledger.** `append` reserves versions in one transaction (conditional `UPDATE` / unique `INSERT` on `stream_name → last_version`), produces to the topic with `acks=all`, then confirms. Produce failure attempts a conditional rollback (only if nobody built on the reservation); a crash between reservation and confirmation is recovered by `drainPending`, which re-produces pending rows. Delivery is therefore at-least-once: readers dedupe by `(stream, version)`. The adapter provides an SQLite convenience layer for one app instance and a PostgreSQL layer for a shared ledger across instances; existing `SqlClient` layers remain supported.
3. **The outbox collapses.** This adapter does not provide `Outbox`. The append already is the publication — a staging table would copy topic → table → topic, and the atomicity that justifies the outbox pattern is unattainable across a sidecar/broker boundary anyway. Cross-context integration consumes event topics directly (checkpointed via `CheckpointStore`, deduped via `Inbox`, which the sidecar does implement). Apps composing all five ports fail loudly at layer assembly — by design, not omission.
4. **Snapshots and checkpoints live in the sidecar.** The topic holds raw events with infinite retention and no compaction (it *is* the history); the sidecar is a rebuildable cache.
5. **A minimal in-package wire client** (Produce v3, Fetch v4, Metadata v0, CreateTopics v4; all non-flexible) instead of a Kafka client dependency — zero runtime deps, versions negotiated and asserted at connect, every Nisshi quirk pinned by tests.

## Consequences

- **Multi-partition is a migration, not a config flip.** When throughput demands it, positions must be re-encoded (per-category topics with independent total orders, or a composite position type) and every checkpoint rewritten. That cost is accepted knowingly; the trigger is sustained produce throughput approaching what one partition and one broker process cannot absorb.
- **Sidecar deployment follows writer topology.** Process-local SQLite is only safe with one writer instance. Multiple app instances that may command the same aggregate must share PostgreSQL so the CAS ledger remains authoritative.
- **Reads of one stream scan the topic** filtered by key; full replay is rare because snapshots cover rehydration. Workloads with millions of streams should measure before adopting this adapter.
- **`append` surfaces produce failures as defects** (the port's error channel admits only `ConcurrencyConflict`); a failed append either rolled back (retry the command) or left pending rows (the relay publishes them). A caller can therefore observe a failed command whose events later appear — at-least-once, deduplicated by version.
- **Nisshi quirks encoded and pinned by tests:** metadata requests for unknown topics auto-create them (4 partitions) — so topics are created before any metadata probe; produce responses trail with `throttle_time_ms`; empty partitions report a high watermark of 1; fetch returns whole batches (the client filters below the requested offset); `CreateTopics` v0/v3 wedge the broker, so v4 is pinned.
- **Broker-side schema validation is deferred:** Nisshi v0.7.0-pre.2 does not enforce its own JSON Schemas (verified with its own CLI). We validate envelopes client-side (default on) and ship `writeSchemaFiles` for the day a release enforces them.

Revisit when: a Nisshi release enforces schema-backed topics (wire the generated files), or aggregate-level throughput justifies the multi-partition migration.
