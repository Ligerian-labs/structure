---
name: serve-http
description: Define and serve an HTTP API in a @structure-based app - schema-typed routes, OpenAPI docs, health probes, CQRS bridge, graceful Bun server. Use when adding an HTTP surface.
---

# Serve an HTTP API

Thin bindings over `@effect/platform` `HttpApi`: schema-typed endpoints with full inference, problem-details error mapping that never leaks internals, OpenAPI docs, health probes, and a Bun server with graceful shutdown. The api surface lives in `packages/http/src/` (`api.ts`, `cqrs.ts`, `docs.ts`, `errors.ts`, `health.ts`, `middleware.ts`, `rateLimit.ts`, `serve.ts`); `packages/http/README.md` documents it, the tests show working usage.

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

   The stack includes the standard middleware: correlation, boundary logging, metrics, problem mapping. The log line (`http request`) and the `http_server*` / `http_request_duration_seconds` metrics carry `method`, `route`, `status`, `durationMs` and the ids — `route` is the matched endpoint template (`/users/:id`) or `(unmatched)`, never the requested path, so nothing carried in a path segment reaches a log sink or a metric label. Propagated `x-request-id` / `x-correlation-id` are kept only when they match `^[A-Za-z0-9_-]{1,64}$`; otherwise a fresh uuid is minted and echoed.

5. **Error mapping**: return typed failures (`InvariantViolation`, `PermissionDenied`, ...) — `toProblem`/`withDefaultErrors` map them to problem+status (`Unauthenticated` → 401, `PermissionDenied` → 403); internals and stacks never cross the wire.
6. **Rate limit** (public or credential routes): provide `rateLimitLayer({ store, groups })` next to the api implementation — `storeFromUrl(redisUrl)` picks Redis (shared budgets) or in-memory (single replica). Each group has a bounded `label`, a `rule` (`points`/`windowMillis`/`blockMillis`), a `match`, and `key` or `keys`. Key IPs with `clientIp(request, { trustProxy })` where `trustProxy` is a setting that is `true` only behind a proxy you operate (it then takes the rightmost `x-forwarded-for` hop; otherwise only the socket address counts). Counted responses carry `RateLimit-*`/`X-RateLimit-*`; denials are `429` + `Retry-After`. For a login wall use `keys` (ip + email digest) with `consumeWhen: (response) => response.status === 401` so successes are free and a victim's address cannot be locked by naming it.
7. **Tests:** real sockets, no fixed ports — `serveTest` on a random port, read `HttpServer.address`. Follow `packages/http/test/http.test.ts` (and `rateLimit.test.ts` for limiter groups).

## Rules

- Endpoints are transport declarations; business decisions live in aggregates, authorization on the bus (or `HttpAuthorization` for non-bus routes) — never re-implemented in handlers.
- Every endpoint declares its success and error schemas; OpenAPI docs are generated, not maintained by hand.
- GET payloads decode from url search params — every encoded field must be a string (or string array); build the endpoint manually for anything richer.
- Use `serve`'s `gracePeriod` for load-balancer drain; readiness must go unready before the listener stops.
- Never annotate logs or metrics with the raw request path or query; label by route template (`Middleware.routeLabel(api)` — `extra` for routes mounted outside the api) and treat everything a client sends as data, not as a label.

## Verify

`bun x tsc --noEmit && bun test` in the package.
