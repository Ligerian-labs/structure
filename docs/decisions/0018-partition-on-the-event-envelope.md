# ADR-0018: An optional partition on the event envelope

- Status: accepted
- Date: 2026-09-07

## Context

An application built on the framework has to run the same event-sourced system on several nodes that hold different subsets of one event store: a hub that holds everything, and per-site nodes that hold their own streams plus a read-only copy of shared streams, offline for hours and replicated later. The framework had no notion of which subset an event belongs to: `EventMetadata` carried identity, ordering, correlation and an optional actor and nothing an application could add; `readAll` took a position and a batch size only, so a node hosting one subset, or an exporter shipping one subset elsewhere, read the whole feed and discarded; the Postgres `events` table had no column to index, filter, or attach a row-level-security policy to; and `HistoryImport` had no place to record where a copied event was first recorded, which a continuous replica needs to resume from.

Every workaround (a key inside every payload, a side table mapping streams to subsets, a wrapper around the store) re-implements a store concern one layer up, invisible to the adapters' indexes and to database policies.

## Decision

We add three optional fields to `EventMetadata` — `partition` (a string locality key), `origin` (`{ node, position }`, the node that first recorded a replicated copy and its position there, a bigint as a decimal string) and `extensions` (an application-owned JSON record) — and an optional `partition` filter on `EventStore.readAll`, implemented by every in-repo adapter. `AggregateStore` stamps `partition` and `extensions` from `CommandMetadata` exactly as it stamps `actor`, and never `origin`, which only an import path sets.

The framework enforces one rule: a stream's partition never changes. It decides nothing else — what a partition means (an agency, a tenant, a shard) and who may write to it are application policy, composed as a layer around the store or as a database policy, never a framework rule (`authorization` keeps not depending on `eventsourcing`).

The Postgres adapter materialises the key as `partition TEXT GENERATED ALWAYS AS (metadata->>'partition') STORED` with an index on `(partition, position)`, so the envelope stays the single source of truth (appends are untouched) while the column exists for the filter, for row-level-security policies, and for declarative table partitioning later. The schema ships as versioned steps (`migrations`: rev 1 the tables up to 0.0.14, rev 2 the column and index) and `migrate()` applies every step, so consumers with their own checksummed migration ledgers append rev 2 as a new entry instead of rewriting a recorded step. The SQLite adapter uses an expression index on `json_extract(metadata, '$.partition')` (an `ALTER TABLE` cannot add a stored generated column there, and the expression index gives an existing database the same plan without a schema change); the Nisshi adapter filters record by record, the topic having no index on the envelope.

`extensions` is an untyped bag on purpose: a generic type parameter on `EventMetadata` would reach into every signature that names the class and is the opposite of additive; a JSON record decoded by the application with its own schema keeps the envelope closed for the framework and open for the application.

## Consequences

Easier: a node or an exporter reads one subset of the feed in global order with the same checkpoint guarantee; a database policy or a partitioned table can be built on a real column; a replicated copy can carry its provenance; an application can attach envelope-level facts (a delegating principal, say) without a payload convention. Nothing changes for an application that never sets a partition: every field and option is optional, `readAll` without a filter runs the same query plus one column nobody reads, and existing frozen histories checksum identically.

Harder: upgrading a large Postgres store rewrites the `events` table once when rev 2 is applied (seconds to minutes under an exclusive lock); release notes name it and the step can run in a maintenance window ahead of the deploy. An adapter that cannot honour the filter must fail rather than ignore it, so a third-party adapter has one more obligation. A filtered feed matches nothing on an unpartitioned store — by design, and a possible surprise the port's documentation states.

Deliberately not decided here: partition-aware jobs and outbox archives, and the continuous replica import that fills `origin` (each a later ADR). Revisit trigger: an application needing the framework to *enforce* a partition (a write refused because the caller may not write to it), or a store that needs a partition to move — either would mean the framework must learn what a partition means, which this decision keeps out of it.
