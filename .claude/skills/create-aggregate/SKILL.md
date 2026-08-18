---
name: create-aggregate
description: Create a DDD aggregate (decider) with its domain events in a @structure-based app. Use when adding a new domain concept that accepts commands and emits events.
---

# Create an aggregate

An aggregate is a decider: `initial` state, `decide` (accept/reject a command, emit events), `evolve` (fold one event into state). Keep `decide`/`evolve` pure; one aggregate = one consistency boundary. Reference: `packages/domain/README.md`.

## Steps

1. **Name things in the ubiquitous language.** Aggregate = noun (`Invoice`), commands = imperative intent (`ApproveInvoice`, never `UpdateInvoice`), events = past-tense facts (`InvoiceApproved`). The aggregate name must not contain `-` (stream naming constraint).
2. **Define the id and events:**

```ts
import { Aggregate, DomainEvent, EntityId, InvariantViolation } from "@structure/domain";
import { Effect, Schema } from "effect";

export const InvoiceId = EntityId.define("InvoiceId");

export const InvoiceApproved = DomainEvent.define("InvoiceApproved", {
  invoiceId: InvoiceId.schema,
  approver: Schema.String,
});
export type InvoiceEvent = typeof InvoiceApproved.Type; // union of all its events
```

3. **Define state and commands** (plain tagged types), then the aggregate:

```ts
export const Invoice = Aggregate.define<InvoiceState, InvoiceCommand, InvoiceEvent, InvariantViolation>({
  name: "Invoice",
  initial: { status: "pending" },
  decide: (state, command) => {
    // reject with Effect.fail(new InvariantViolation({ rule: "..." }))
    // accept with Effect.succeed([Event.make({ ... })])
  },
  evolve: (state, event) => {
    // total, side-effect free fold; unknown tags return state unchanged
  },
});
```

4. **Persist it event-sourced** (usual case): register the events in an `EventRegistry` and use `AggregateStore` from `@structure/eventsourcing`; use `executeWithRetry` for optimistic-concurrency retries. For simple state-stored contexts implement the `Repository` port from `@structure/domain` instead.
5. **Tests first-class:** decide-accepts (state + events asserted), decide-rejects (invariant), `Aggregate.rehydrate` from a history. Follow `packages/domain/test/domain.test.ts`.

## Rules

- Events record accepted facts only; a failed validation is not an event.
- Reference other aggregates by id; never load them inside `decide`.
- Emitting to other contexts goes through the outbox as integration events, not by sharing these event types.

## Verify

`bun x tsc --noEmit && bun test` in the package.
