# @structure-ai/client

A typed, opinionated API client **derived from the `Api` type** — no code generation. For consumers that share the api definition at compile time (a frontend app in the same workspace), any change to the api breaks client compilation, so drift is caught by `tsc`, not by a generation step. External and non-TypeScript consumers use the api's `openapi.json` instead.

## Usage

```ts
import { FetchHttpClient } from "@effect/platform/FetchHttpClient";
import { Effect } from "effect";
import * as StructureClient from "@structure-ai/client";
import { myApi } from "../server/api.js"; // the app's Api value: pure schema data

const program = Effect.gen(function* () {
  const client = yield* StructureClient.make(myApi, {
    baseUrl: "http://127.0.0.1:3000",
    bearer: () => getToken(), // evaluated per request
    timeout: "5 seconds",
    retry: { attempts: 3, baseDelay: 100, maxDelay: 5_000 },
  });

  // Fully typed: success payload, declared business failures, HttpProblem responses.
  const placed = yield* client.orders.placeOrder({ payload: { name: "x", sku: "sku-1" } });
}).pipe(Effect.provide(FetchHttpClient.layer));
```

## Transport opinions

- **Correlation:** every request carries `x-correlation-id` — the ambient
  `@structure-ai/observability` correlation when one is active (wrap a user
  interaction in `Correlation.within`), otherwise a fresh id. Failures echo the
  server's correlation id, so a support ticket maps straight to server logs.
- **Bearer:** the token provider runs per request; short-lived tokens work
  without rebuilding the client.
- **Deadline:** `timeout` applies per attempt and interrupts the request
  mid-flight, failing with `RequestTimeout` (`classification: "transient"`).
- **Retries:** bounded exponential backoff **with jitter** (default 3 attempts,
  100 ms base, 5 s cap) for transient transport failures only — network errors,
  5xx responses, dispatch timeouts, and errors carrying
  `classification: "transient"`. Business failures (422) and permanent problems
  are never retried; the caller sees them on the first attempt. This client is
  the single retry owner for its calls — don't nest another retry policy around
  it. Retried **commands** should carry an `x-idempotency-key` header; the
  `@structure-ai/http` CQRS bridge forwards it into the dispatch envelope.

## Exports

| Export | What it is |
| --- | --- |
| `make(api, options)` | Derives the typed client. Requires an `HttpClient` in context — provide `FetchHttpClient.layer` (browser and Bun). |
| `ClientOptions` | `baseUrl`, `headers?`, `bearer?`, `timeout?`, `retry?`. |
| `RetryOptions` | `attempts?`, `baseDelay?`, `maxDelay?` for the jittered backoff. |
| `RequestTimeout` | Tagged error for a per-attempt deadline exceeded; `classification: "transient"`. |

Declared business failures surface as typed failures because the
`@structure-ai/http` CQRS bridge declares each definition's `failure` schema on
its endpoint (422, `_tag`-discriminated) — see that package's tests. The tests
in `test/client.test.ts` run a real server on a random port and exercise
success, typed failures, retry recovery, retry exhaustion, correlation, bearer,
and deadlines end to end.
