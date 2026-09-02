# @structure-ai/cqrs

Logical CQRS: Schema-typed commands and queries, one handler per message, buses as Effect services. Every dispatch goes through the same pipeline: boundary validation (shape only — business rules stay in the domain) → authorization → idempotency claim (commands with a key) → traced, measured handler execution.

## Usage

```ts
import { Command, CommandBus, CommandHandler, HandlerRegistry, layer } from "@structure-ai/cqrs";
import { Effect, Schema } from "effect";

const ApproveInvoice = Command.define("ApproveInvoice", {
  payload: Schema.Struct({ invoiceId: Schema.String, approver: Schema.String }),
  success: Schema.Struct({ invoiceId: Schema.String, version: Schema.Number }),
});

const handlers = HandlerRegistry.layer(
  CommandHandler.make(ApproveInvoice, (payload, dispatch) =>
    Effect.succeed({ invoiceId: payload.invoiceId, version: 2 }),
  ),
);

const program = Effect.gen(function* () {
  const bus = yield* CommandBus;
  const ack = yield* bus.dispatch(ApproveInvoice, { invoiceId: "inv-1", approver: "ada" }, {
    idempotencyKey: "req-42",
  });
}).pipe(Effect.provide(layer.pipe(Layer.provide(handlers)))); // convenience layer: both buses, allow-all authorizer, in-memory idempotency
```

## Exports

| Export | What it is |
| --- | --- |
| `Command.define(tag, { payload, success, failure? })` / `Query.define` | Intent-named message definitions; `failure` types the handler's error channel (in-process only). |
| `CommandHandler.make` / `QueryHandler.make` | Bind a definition to a handler `(payload, dispatch) => Effect`; `dispatch` carries messageId, correlationId, causationId, actor, idempotencyKey. |
| `HandlerRegistry.layer(...registrations)` | Collects handlers (duplicate tag = defect at build time); captures handler service requirements from the context at build — satisfy them with `Layer.provideMerge`, not `Layer.provide`, or the services are spent building the registry and missing from the runtime context (missing-service defects at dispatch, invisible to the type checker). |
| `CommandBus` / `QueryBus` (+ `.layer`, convenience `layer`) | `dispatch(definition, input, { idempotencyKey?, actor?, timeout? })`. |
| `Authorizer` (+ `allowAll`) | Hook authorizing the requested action (tag/kind/actor/payload), not the endpoint. |
| `IdempotencyStore` (+ `inMemory`), `IdempotencyStoreService`, `IdempotencyContext`, `BeginOutcome` | Port for command idempotency: `begin(context)` claims `(tag, actor, key)` and returns `Completed(result)` / `Claimed` / `InFlight` / `Mismatch`; `complete(context, result)` records the wire-encoded success; `release(context)` frees a failed claim. `inMemory` is process-local; `@structure-ai/eventsourcing-pg` ships a durable one with TTL. |
| `HandlerNotFound`, `Unauthorized`, `DispatchTimeout`, `IdempotencyMismatch`, `IdempotencyInFlight` | Tagged errors with `classification`; validation failures reuse `ValidationFailed` from `@structure-ai/domain`. |

Each dispatch runs in a span (`cqrs.command.<Tag>`), a metrics boundary (calls/errors/latency), and `Correlation.within` with `causationId = messageId`.

## Idempotency

A command dispatched with `idempotencyKey` is identified by the key **scoped to the acting principal** (`options.actor`, falling back to the ambient correlation actor; anonymous is its own scope) **and the command tag**, and bound to a sha-256 of the validated payload in wire form (object keys sorted, so field order is irrelevant). Queries ignore the key.

| Situation | Outcome |
| --- | --- |
| First dispatch of the key | Store returns `Claimed`; the handler runs; its success is encoded with the definition's `success` schema and stored with `complete`. |
| Same actor, same payload, again | `Completed`: the stored success is decoded and returned; the handler does not run (nor is anything traced). |
| Same actor, same key, **different payload** | `IdempotencyMismatch` (`classification: "conflict"`, HTTP 409): the handler does not run. |
| Same actor, same key, first dispatch **still running** | `IdempotencyInFlight` (`classification: "transient"`, HTTP 409): retry once it finished to get its result. |
| Another actor, same key | Independent claim: the handler runs again. Keys never leak results across principals. |
| The claimed dispatch fails, times out or is interrupted | The claim is released; the next dispatch runs the handler again. |

Stored results are the *encoded* success, so a durable store only ever holds JSON — make sure every field of a command's `success` schema round-trips (`Schema.Date`, branded ids and the like do). The store suppresses replays and duplicate concurrent runs of one key; exactly-once processing of *events* is the eventsourcing inbox's job.
