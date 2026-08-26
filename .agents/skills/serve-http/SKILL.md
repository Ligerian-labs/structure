---
name: serve-http
description: Define and serve an HTTP API in a @structure-based app - schema-typed routes, OpenAPI docs, health probes, CQRS bridge, graceful Bun server. Use when adding an HTTP surface.
---

# Serve an HTTP API

Thin bindings over `@effect/platform` `HttpApi`: schema-typed endpoints with full inference, problem-details error mapping that never leaks internals, OpenAPI docs, health probes, and a Bun server with graceful shutdown. The api surface lives in `packages/http/src/` (`api.ts`, `cqrs.ts`, `docs.ts`, `errors.ts`, `health.ts`, `serve.ts`) — the package has no README; the sources and tests are the reference.

## Steps

1. **Define groups and endpoints** — schema-typed path params, payloads, successes:

```ts
import { annotate, Api, ApiEndpoint, ApiGroup, ApiSchema } from "@structure-ai/http";
import { Schema } from "effect";

const users = ApiGroup.make("users").add(
  ApiEndpoint.get("getUser")`/users/${ApiSchema.param("id", Schema.String)}`
    .addSuccess(Schema.Struct({ id: Schema.String, name: Schema.String })),
);

const api = Api.make("my-api").add(users).pipe(
  annotate({ title: "My API", version: "1.0.0" }),
);
```

2. **Bridge CQRS instead of hand-writing handlers** when the use case exists: `HttpCqrs.commandEndpoint(name, path, ApproveInvoice)` / `queryEndpoint(...)` declare the endpoint; `handlers.handle("addItem", HttpCqrs.command(AddItem))` implements it. Deep validation happens once on the bus; dispatch errors map to problem responses (504 on `timeout`).
3. **Add health probes**: `.add(Health.group)` on the api + `Health.layer(api)` — `/health/live` always answers, `/health/ready` reflects `Readiness.checkAll` with the per-check report.
4. **Implement and serve** — one launchable layer; shutdown flips readiness unready first:

```ts
import { Docs, serve } from "@structure-ai/http";
import { Readiness } from "@structure-ai/runtime";

serve({ port: 3000, gracePeriod: Duration.seconds(5) }).pipe(
  Layer.provide(Docs.layer()),     // /docs (OpenAPI JSON + Swagger UI)
  Layer.provide(MyApiLive),        // HttpApiBuilder.api(api) + group layers
  Layer.provide(Readiness.layer),
  Layer.launch,
);
```

   The stack includes the standard middleware: correlation, boundary logging, metrics, problem mapping.

5. **Error mapping**: return typed failures (`InvariantViolation`, `PermissionDenied`, ...) — `toProblem`/`withDefaultErrors` map them to problem+status (`Unauthenticated` → 401, `PermissionDenied` → 403); internals and stacks never cross the wire.
6. **Tests:** real sockets, no fixed ports — `serveTest` on a random port, read `HttpServer.address`. Follow `packages/http/test/http.test.ts`.

## Rules

- Endpoints are transport declarations; business decisions live in aggregates, authorization on the bus (or `HttpAuthorization` for non-bus routes) — never re-implemented in handlers.
- Every endpoint declares its success and error schemas; OpenAPI docs are generated, not maintained by hand.
- GET payloads decode from url search params — every encoded field must be a string (or string array); build the endpoint manually for anything richer.
- Use `serve`'s `gracePeriod` for load-balancer drain; readiness must go unready before the listener stops.

## Verify

`bun x tsc --noEmit && bun test` in the package.
