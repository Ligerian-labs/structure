# @structure-ai/observability

Structured logging, correlation, metrics, and telemetry export for Effect apps. One layer wires the full stack; every log record is a single JSON line with stable fields, bounded sizes, and the correlation ids of the workflow that produced it.

## Usage

```ts
import * as Observability from "@structure-ai/observability";
import { Effect, LogLevel } from "effect";

const obs = Observability.layer({
  service: { name: "billing", version: "1.4.2" },
  logLevel: LogLevel.Info,
  logFormat: "json",            // "pretty" for local development
  otlpUrl: "http://localhost:4318", // omit → no telemetry export
  redactKeys: ["authorization", "password"], // optional key-based redaction, any depth
});

const handler = Effect.gen(function* () {
  yield* Effect.log("invoice accepted");    // carries correlation ids automatically
}).pipe(
  Observability.Correlation.within({ requestId: "req-1" }),
  Observability.Metrics.track("billing_accept"), // span + calls/errors/latency metrics
  Effect.provide(obs),
);
```

## Exports

| Export | What it is |
| --- | --- |
| `layer(options)` | Composed stack: `ServiceMeta` + logger + level + optional OTLP export. |
| `ServiceMeta` | Service identity tag (`name`/`version`/`instance`) + `ServiceMeta.layer(...)`. |
| `Correlation.within(ctx)` / `Correlation.scoped()` | Merge correlation/causation/request/actor ids into the fiber; annotate logs and spans. `scoped` mints a correlationId when absent. |
| `Correlation.current` / `Correlation.newId()` | Read the active context / make an id. |
| `Metrics.boundary(name)` / `Metrics.track(name)` | Traffic + error counters and latency histogram, plus a span, for a named boundary. |
| `makeJsonLogger(service, write?, options?)` / `layerJson(write?, options?)` | The structured logger; inject `write` to capture output in tests. `options.redactKeys` censors keys at any depth. |
| `layerPretty` / `layerSilent` / `layerMinimumLevel(level)` | Dev logger, no-logs (tests), level filter. |
| `layerOtlp({ baseUrl, headers? })` | Pure-Effect OTLP export of traces/metrics/logs (no OTel JS SDK). |
| `observabilitySettings` | Ready-made `@structure-ai/config` settings (`LOG_LEVEL`, `LOG_FORMAT`, `OTLP_URL`). |

Telemetry export failure never takes down the workload.

## Structured annotations and messages

Annotation values and non-string message values are rendered as JSON structure, not `String()`: `Effect.annotateLogs({ req: { method, route, status } })` lands as `annotations.req.method` in the record, and `Effect.log("request completed", { method, status })` yields `event: "request completed"` plus `data: { method, status }` (`data` holds the single structured value, or an array when several were passed; when a call carries no string, `event` is the JSON text of the payload).

Rendering rules, applied recursively:

| Value | Rendered as |
| --- | --- |
| plain object / array / `Map` / `Set` | JSON object / array (`Map` keys stringified) |
| `Redacted` | `"<redacted>"` |
| `Date` | ISO string |
| `Error` | `{ name, message, ...ownFields }` (`stack` omitted; tagged errors keep `_tag` and `classification`) |
| Effect data types (`Schema.Class`, `Option`, `Chunk`…) | their `toJSON()` output |
| `bigint` | decimal string |
| anything with its own `toString` (`URL`, `RegExp`…) | that string |

Every axis is bounded so a record can't grow unbounded, and each bound leaves a marker instead of silently dropping data:

| Bound | Limit | Marker |
| --- | --- | --- |
| string length | 2 KB | `…[truncated]` suffix |
| keys per object (including the top-level annotations) | 64 | extra key `"…[truncated]": <dropped count>` |
| items per array | 128 | trailing `"…[truncated: <dropped count>]"` |
| nesting depth | 8 | `"[truncated: depth]"` |
| cycles | — | `"[circular]"` (never throws) |

`redactKeys` (on `layer`, `layerJson`, `makeJsonLogger`) is the second wall behind `Redacted` values, for payloads the caller did not build: any key matching one of the names (case-insensitive) renders as `"[redacted]"` at any depth, including top-level annotation keys. It is a backstop, not a license: never log secrets, tokens, or prompt bodies.
