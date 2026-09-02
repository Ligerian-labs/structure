# @structure-ai/http

HTTP surface for `@structure` apps: schema-typed `HttpApi` routes over `@effect/platform`, OpenAPI docs, health probes, request correlation, problem-details error mapping, a CQRS endpoint bridge, graceful Bun serving — and rate-limiting middleware with shared or in-process buckets.

## Quick start

```ts
import { Api, ApiEndpoint, ApiGroup, serve } from "@structure-ai/http";
import { Readiness } from "@structure-ai/runtime";
import { Effect, Layer, Schema } from "effect";

const hello = ApiGroup.make("hello").add(
  ApiEndpoint.get("greet", "/hello").addSuccess(Schema.Struct({ hello: Schema.String })),
);

const api = Api.make("demo").add(hello);

serve({ port: 3000 }).pipe(
  Layer.provide(HttpApiBuilder.api(api).pipe(Layer.provide(HelloLive))),
  Layer.provide(Readiness.layer),
  Layer.launch,
);
```

`serve` installs the standard middleware stack — correlation ids, one structured log line per request, boundary metrics, problem mapping — and graceful shutdown (readiness flips unready before the listener stops).

## Rate limiting

`rateLimitLayer` (or the `rateLimit` HttpApp middleware) enforces per-route-group budgets with `points` per sliding `windowMillis` and a `blockMillis` lockout:

```ts
import { makeInMemoryStore, rateLimitLayer, clientIp } from "@structure-ai/http";

const limiter = rateLimitLayer({
  store: makeInMemoryStore(),
  groups: [
    {
      label: "auth",                       // bounded metric/log label
      rule: { points: 10, windowMillis: 60_000, blockMillis: 30_000 },
      match: (request) => request.url.startsWith("/auth"),
      key: (request) => principalIdOr(request) ?? clientIp(request),
    },
  ],
});
// provide `limiter` next to Middleware.layer in serve()
```

Semantics:

- `OPTIONS` preflights and `/health/*` probes **never consume budget**;
- a denied request gets `429` + `Retry-After` (problem body with the correlation id) and a warning log tagged with the route label;
- store failures **fail open** by default (counted as `http_rate_limit_store_errors_total`); `onStoreError: "deny"` fails closed;
- metrics: `http_rate_limit_consumed_total` / `http_rate_limit_blocked_total`, tagged `route`.

Stores:

| Store | Use |
| --- | --- |
| `makeInMemoryStore()` | Single replica: bounded key map, lazy sweep, atomic in one event loop turn. |
| `makeRedisStore({ url })` | Shared across replicas: atomic sliding window + block in one Lua `EVAL` over a dependency-free RESP2 client (`makeRedisClient`). |
| `storeFromUrl(url?)` | No URL → in-memory + startup warning stating single-replica scope; URL → Redis store. |

Keys come from the app (principal id, IP, route+principal…): `clientIp(request)` extracts best-effort client IPs (`x-forwarded-for` → `x-real-ip` → socket). Because `@structure-ai/http` never depends on `@structure-ai/authorization`, principal-keyed groups resolve their key through a closure the app owns (e.g. reading `Principal.current` from its own composition).

## Errors

Failures render as problem-details responses (`{ error, message, correlationId?, issues? }`): `ValidationFailed` → 400, `Unauthenticated` → 401, `Unauthorized`/`PermissionDenied` → 403, `NotFound` → 404, `ConcurrencyConflict`/`IdempotencyMismatch`/`IdempotencyInFlight` → 409, `TooManyRequests` → 429 (+ `Retry-After`), `DispatchTimeout` → 504, anything else → 500 with the correlation id only. Use `withDefaultErrors(endpoint)` to declare the set on an endpoint.
