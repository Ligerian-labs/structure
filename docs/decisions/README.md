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
| [0009](0009-auth-without-auth-dependencies.md) | Authentication protocols behind application-owned ports, without auth dependencies |
| [0010](0010-authorization-as-typed-policy-value.md) | Authorization is a typed, fail-closed policy value; transports adapt to it |
| [0011](0011-cross-agent-skills-directory.md) | Task skills live canonically in `.agents/skills/`; Claude Code via local symlink |
| [0012](0012-typed-client-without-codegen.md) | Typed API clients are derived from the `Api` type, never generated; business failures are declared wire contracts (422) |
| [0013](0013-bdd-on-bun-test.md) | Gherkin feature testing compiles into `bun test` cases; cucumber is a library, not the runner |
| [0014](0014-e2e-playwright-control-plane.md) | Browser E2E drives the real app subprocess through Playwright against a bearer-guarded test control plane; bdd stays the API-scenario layer |
| [0015](0015-dynamodb-adapters.md) | DynamoDB adapters: single table with overloaded keys, ULID positions (approximate global order), transactional append+outbox, ensureTables over SQL migrations |
