# ADR-0019: Composable fixtures through application commands

Status: accepted

## Context

Business feature work needs repeatable application states: shared users and CMS content plus scenarios for sales, stock and other flows. Ad hoc seeding bypasses validation or leaves projections stale, and test-local setup is difficult to reuse for manual exploration.

## Decision

Add `@structure-ai/fixtures` above CQRS, with a CLI subpath above `@structure-ai/cli`. Explicit fixture instances form a dependency graph. An instance object is shared once per run; distinct definitions using the same key are rejected before writes. Typed factory functions provide parameters and overrides, and scenario input schemas validate CLI arguments. Catalogs prepend shared base fixtures.

Execute through the supplied application command bus, sequentially, with a new run UUID and deterministic UUIDs within that run. The app owns persistence, authorization, external adapters and run ownership. Require an explicit readiness hook and bound total execution time. Retain completed data on success or failure, expose completion receipts, and leave cleanup to app commands scoped to one run. There is no cross-command rollback, automatic retry or durable fixture-run registry.

Mutation requires an explicit app-owned capability, disabled by default and never granted for production targets. Production CMS provisioning has a separate deployment workflow and no fixture override. Library code does not infer environment policy from names or connection strings.

## Consequences

The same definitions work with in-memory test layers and durable development/preview layers. Agents get discoverable scenarios, input validation, dependency planning and safe receipts through the CLI. Fixture outputs and required services remain typed for direct in-process composition; named catalog outputs are heterogeneous.

Applications must model the run namespace, use isolated external adapters and implement readiness and cleanup correctly. Fresh IDs do not isolate global singleton settings or undo external side effects. Scenario builders are pure application code, not a sandbox. Existing BDD worlds and browser test control planes can call fixtures through app-owned composition without adding dependency cycles or a new transport.
