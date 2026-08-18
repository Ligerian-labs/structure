# Architecture decision records

Numbered, immutable once accepted; reversing a decision means a new ADR marking the old one superseded. Start from [0000-template.md](0000-template.md).

| ADR | Decision |
| --- | --- |
| [0001](0001-bun-turbo-biome-workspace-only.md) | Bun + Turborepo + Biome; packages consumed as TypeScript source |
| [0002](0002-effect-as-foundation.md) | Effect as the single foundation; thin bindings over its ecosystem |
| [0003](0003-decider-aggregates.md) | Aggregates are deciders shared by state-stored and event-sourced persistence |
| [0004](0004-ports-and-adapters-eventsourcing.md) | Event-sourcing ports in core, SQL adapters as packages, transactional outbox |
| [0005](0005-forward-only-migrations.md) | Forward-only, all-or-nothing migrations |
| [0006](0006-viewmodel-not-an-orm.md) | View models are a query-side mapper, not a general ORM |
| [0007](0007-pure-effect-otlp.md) | Telemetry export via pure-Effect OTLP, not the OTel JS SDK |
| [0008](0008-agent-consumable-repo.md) | The repository is a first-class interface for coding agents |
