---
name: create-command
description: Define a CQRS command or query with its handler and expose it (HTTP endpoint or MCP tool) in a @structure-based app. Use when adding a new use case.
---

# Create a command (or query)

Commands change state through one aggregate; queries read view models and never mutate. Boundary validation (shape) happens on the bus; business rules stay in the aggregate's `decide`. Reference: `packages/cqrs/README.md`.

## Steps

1. **Define the message** (intent-named, Schema payload + success):

```ts
import { Command } from "@structure-ai/cqrs"; // or Query
import { Schema } from "effect";

export const ApproveInvoice = Command.define("ApproveInvoice", {
  payload: Schema.Struct({ invoiceId: Schema.String, approver: Schema.String }),
  success: Schema.Struct({ invoiceId: Schema.String, version: Schema.Number }),
});
```

2. **Write the handler** — thin: authorize is the bus's job, business decisions are the aggregate's. A command handler loads/executes the aggregate (via `AggregateStore.executeWithRetry`) and returns a minimal ack (id, version, status). A query handler reads a `ViewStore` and returns the shaped result.

```ts
import { CommandHandler, HandlerRegistry } from "@structure-ai/cqrs";

export const handlers = HandlerRegistry.layer(
  CommandHandler.make(ApproveInvoice, (payload, dispatch) => /* Effect */),
);
```

3. **Wire the bus:** provide `@structure-ai/cqrs`'s convenience `layer` (both buses, allow-all authorizer, in-memory idempotency) with your `handlers`; replace the `Authorizer` layer when the action needs real authorization (authorize the action, not the endpoint).
4. **Expose it:**
   - HTTP: `HttpCqrs.command(ApproveInvoice)` as the endpoint handler, or `commandEndpoint(name, path, def)` one-liner (`packages/http/README.md`). Problem responses and OpenAPI come for free.
   - MCP: `toolFromCommand(ApproveInvoice)` (`packages/mcp/README.md`).
5. **Idempotency:** if callers may retry, pass `idempotencyKey` on dispatch (HTTP: the bridge forwards `x-idempotency-key`). The key is scoped to the actor and the command tag and bound to the payload: same actor + same payload replays the stored success without running the handler; a different payload fails `IdempotencyMismatch` (409); a still-running dispatch fails `IdempotencyInFlight` (409, retry later); another actor's same key runs independently. Always pass `actor` (bridge `actor` option / `Correlation.within`) — anonymous dispatches share one scope. The command's `success` schema must round-trip through encode/decode (results are stored in wire form). Production: provide `@structure-ai/eventsourcing-pg`'s `IdempotencyStore` (`layer`/`idempotencyStoreLayer`, `idempotencyTtl`) instead of the in-memory default, and schedule `purgeExpiredIdempotency`. Exactly-once *event* processing still belongs to the eventsourcing inbox.
6. **Tests:** dispatch roundtrip, validation failure (bad payload → `ValidationFailed`, handler not invoked), idempotent replay when a key is used (same key twice → one handler run; different payload → `IdempotencyMismatch`), plus one per exposed surface. Follow `packages/cqrs/test/cqrs.test.ts` and `packages/http/test/http.test.ts`.

## Rules

- One command → one handler → normally one aggregate transaction.
- Queries must have no side effects; if a "query" needs to write, it's a command.
- Never return the whole write model as a command response.

## Verify

`bun x tsc --noEmit && bun test` in the package.
