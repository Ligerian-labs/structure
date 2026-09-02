# ADR-0015: DynamoDB adapters — single table, ULID global feed, transactional outbox

- Status: accepted
- Date: 2026-09-01

## Context

The durable event-sourcing adapters exist for SQLite and PostgreSQL; AWS-hosted applications need a DynamoDB equivalent for the same ports (`EventStore`, `SnapshotStore`, `CheckpointStore`, `Outbox`, `Inbox`), later `ViewStore` and `AuthStore`. DynamoDB has no autoincrement, no cross-partition ordering, no multi-item transactions outside `TransactWriteItems`, and GSIs are eventually consistent — the SQL adapters' foundations (BIGSERIAL positions, `ORDER BY`, ACID transactions) do not transfer. Modeling guidance comes from *The DynamoDB Book* (DeBrie): overloaded prefixed keys on generic `pk`/`sk` (ch. 3.6), a `Type` discriminator per item (ch. 9.4), KSUID/ULID-style time-ordered identifiers for roughly-chronological ordering (ch. 14, 16), keyset pagination (ch. 16.3), sparse indexes for status-scoped reads (ch. 13.4), TTL with expiry-check-on-read (ch. 3.2), and counter items as the known-cost coordination tool (ch. 16.2).

## Decision

Three packages mirroring the SQL adapter split — `@structure-ai/eventsourcing-dynamodb`, `@structure-ai/viewmodel-dynamodb`, `@structure-ai/auth-dynamodb` — on `@effect-aws/dynamodb` (the lib-dynamodb document client as an Effect service; raw `@aws-sdk/client-dynamodb` only where the data-plane client cannot serve, e.g. streams).

- **Single table with key overloads**: one table per application (default `structure`), generic `pk`/`sk` with entity prefixes (`S#` streams, `C#` checkpoints, `O#` outbox, `I#` inbox), an item `entity` discriminator, and two GSIs: `feed` (global event order) and `status` (sparse outbox status reads). No per-port tables; ports share the item space without sharing items.
- **Positions are ULIDs mapped to `bigint`**: per-stream order stays exact (versions); the global feed is ordered by a ULID (48-bit ms timestamp + 80 random bits, monotonic per process). The port's "global position order" becomes "monotonic, resumable, approximately-ordered globally" — clock skew between writers can interleave commits by a bounded margin. The counter-item alternative (book 16.2) buys strict order at the cost of a hot-partition write per append and is the documented escape hatch.
- **Append is one `TransactWriteItems`**: a conditional update of the stream-head item (`if_not_exists(v, 0) = :expected`, the optimistic-concurrency gate) plus the event puts — and, with `appendWithOutbox`, the outbox puts. `ConditionalCheckFailed`/`TransactionCanceled` map to `ConcurrencyConflict` (actual version re-read, like the pg adapter's constraint-violation path). ≤99 items per transaction; larger appends are rejected loudly.
- **Outbox**: one item per message (`O#<id>`, idempotent `enqueue` via `attribute_not_exists`), a sparse `status` GSI carrying only non-terminal entries (`pending`/`dead` partition values, ULID enqueue-time sort) — published entries vanish from the index by attribute removal. `Inbox` dedup keys carry a TTL with expiry-checked reads (book 3.2).
- **Bootstrap is `ensureTables`**: idempotent `CreateTable` (with GSIs) or `UpdateTable` for missing GSIs, wait-for-active, TTL enablement — run by the all-in-one `layer` at build time. This replaces `@structure-ai/migrations` (SQL-only by ADR-0005); evolving access patterns later means GSI additions, which are async and outside the forward-only migration model.
- **Eventual-consistency posture**: `readAll` queries the `feed` GSI, which cannot be strongly consistent — projections converge on poll cycles, and tests wait on convergence instead of single-read assertions.
- **Testing** is against DynamoDB Local only (no real-AWS suite in CI); scenarios are the third copy of the shared SQL-adapter behavioral suite, per the repo's no-cross-package-test-imports convention.

## Consequences

Easier: SQL-port parity on a single AWS-native database; cheap key-value ports (checkpoints, snapshots, inbox); conditional writes give optimistic concurrency without schema constraints; TTL cleans the inbox without jobs; one billing surface.

Harder: no strict global event order (approximate by ULID; a counter escape hatch exists but is unimplemented); `readAll` is GSI-eventually-consistent; the feed GSI is a single logical partition — throughput ceiling documented, sharding is the revisit trigger; transactions cap appends at 99 items; DynamoDB Local fidelity gaps (no adaptive capacity, simplified timing) are accepted as the test contract.

Revisit triggers: strict-order requirements from a real app (add the counter-item position mode), feed throughput ceilings (shard the feed key), a real-AWS CI suite if Local fidelity ever masks a production behavior, and multi-region/global-table needs (conditional-write semantics under replication need their own decision).
