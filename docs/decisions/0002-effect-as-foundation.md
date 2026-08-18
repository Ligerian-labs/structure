# ADR-0002: Effect as the single foundation

- Status: accepted
- Date: 2026-08-18

## Context

The framework needs typed errors, dependency injection, structured concurrency, config, schema validation, HTTP, CLI, SQL, telemetry, and LLM bindings — either assembled from many libraries or taken from one coherent ecosystem.

## Decision

Everything builds on Effect v3 and its first-party ecosystem (`@effect/platform`, `@effect/cli`, `@effect/sql`, `@effect/opentelemetry`, `@effect/ai`). Framework packages are thin, opinionated bindings — they re-export or alias upstream primitives when those are already ergonomic, and only wrap where a repo convention (error taxonomy, correlation, redaction) must be enforced.

## Consequences

- Uniform composition model (Layer/Effect/Schema) across all 14 packages; typed errors end to end.
- The ecosystem's minor versions move fast and APIs churn: the repo rule is to verify signatures against the installed `.d.ts` before use (encoded in AGENTS.md), and the catalog pins one version set.
- Consumers must buy into Effect; this is a feature (coherence), not a bug, for this framework's audience.
- Revisit only if Effect's release cadence starts breaking us faster than the catalog + CI can absorb.
