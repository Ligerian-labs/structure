# @structure-ai/domain

DDD tactical building blocks. An aggregate is a *decider*: `decide` accepts or rejects a command against current state and emits events; `evolve` folds an event into state. The same definition drives state-stored persistence and event sourcing (`@structure-ai/eventsourcing`).

## Usage

```ts
import { Aggregate, DomainEvent, EntityId, InvariantViolation, ValueObject } from "@structure-ai/domain";
import { Effect, Schema } from "effect";

const InvoiceId = EntityId.define("InvoiceId");
const Money = ValueObject.define("Money", Schema.Struct({
  amount: Schema.Number.pipe(Schema.nonNegative()),
  currency: Schema.Literal("EUR", "USD"),
}));

const InvoiceApproved = DomainEvent.define("InvoiceApproved", {
  invoiceId: InvoiceId.schema,
  approver: Schema.String,
});

const Invoice = Aggregate.define({
  name: "Invoice",
  initial: { status: "pending" as const },
  decide: (state, command: { _tag: "ApproveInvoice"; id: EntityId.Of<typeof InvoiceId>; approver: string }) =>
    state.status === "pending"
      ? Effect.succeed([InvoiceApproved.make({ invoiceId: command.id, approver: command.approver })])
      : Effect.fail(new InvariantViolation({ rule: "only a pending invoice can be approved" })),
  evolve: (state, event) => (event._tag === "InvoiceApproved" ? { status: "approved" as const } : state),
});
```

## Exports

| Export | What it is |
| --- | --- |
| `EntityId.define(name)` | Branded, validated string id: `schema`, `make(raw)`, `generate()`; `EntityId.Of<typeof X>` is its type. |
| `ValueObject.define(name, schema)` | Self-validating immutable value: `from(unknown)` → `Either<A, ValidationFailed>` (all issues), `make`, `is`. |
| `Aggregate.define / rehydrate / execute` | Decider definition; fold history; run one command returning `{ state, events }`. |
| `DomainEvent.define(tag, fields)` | Past-tense event schema (`Schema.TaggedStruct`). |
| `EventMetadata` / `Envelope<E>` | Persisted/published event envelope: eventId, occurredAt, aggregate identity + version, correlation/causation, optional actor. |
| `Repository` | Load/save port with `Versioned<A>` and optimistic version checks. |
| `InvariantViolation`, `NotFound`, `ConcurrencyConflict`, `ValidationFailed` | Tagged errors with `classification: FailureClass` (`transient`/`permanent`/`conflict`). |

Events record accepted facts only — a failed validation is not a domain event. Keep `decide`/`evolve` pure; effects belong in application services.
