# ADR-0003: Aggregates are deciders shared by state-stored and event-sourced persistence

- Status: accepted
- Date: 2026-08-18

## Context

DDD aggregates need to work both for simple contexts (state in a table) and event-sourced ones, without two competing abstractions.

## Decision

An aggregate is `{ name, initial, decide, evolve }`: `decide(state, command) → Effect<Event[], DomainError>` and `evolve(state, event) → state`, both pure. State-stored persistence saves the folded state through the `Repository` port; event sourcing saves the events through `AggregateStore` and rebuilds by folding. Events are defined with Schema (`DomainEvent.define`) so the same definitions drive persistence codecs, projections, and upcasting.

## Consequences

- One mental model; migrating a context from state-stored to event-sourced changes the persistence layer, not the domain code.
- `decide`/`evolve` purity makes aggregate tests trivial (no infrastructure).
- Constraint inherited by stream naming: aggregate names must not contain `-` (stream = `<name>-<id>`).
- Rich behavior that doesn't fit decide/evolve (process managers, sagas) lives outside the aggregate — by design.
