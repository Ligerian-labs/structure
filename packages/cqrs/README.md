# @structure/cqrs

Logical CQRS: Schema-typed commands and queries, one handler per message, buses as Effect services. Every dispatch goes through the same pipeline: boundary validation (shape only — business rules stay in the domain) → authorization → idempotency (commands) → traced, measured handler execution.

## Usage

```ts
import { Command, CommandBus, CommandHandler, HandlerRegistry, layer } from "@structure/cqrs";
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
| `HandlerRegistry.layer(...registrations)` | Collects handlers (duplicate tag = defect at build time); resolves handler service requirements at layer build. |
| `CommandBus` / `QueryBus` (+ `.layer`, convenience `layer`) | `dispatch(definition, input, { idempotencyKey?, actor?, timeout? })`. |
| `Authorizer` (+ `allowAll`) | Hook authorizing the requested action (tag/kind/actor/payload), not the endpoint. |
| `IdempotencyStore` (+ `inMemory`) | Completed keys replay the cached success without re-running the handler. Durable exactly-once belongs to `@structure/eventsourcing`'s inbox. |
| `HandlerNotFound`, `Unauthorized`, `DispatchTimeout` | Tagged errors with `classification`; validation failures reuse `ValidationFailed` from `@structure/domain`. |

Each dispatch runs in a span (`cqrs.command.<Tag>`), a metrics boundary (calls/errors/latency), and `Correlation.within` with `causationId = messageId`.
