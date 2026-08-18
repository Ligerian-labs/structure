# @structure/observability

Structured logging, correlation, metrics, and telemetry export for Effect apps. One layer wires the full stack; every log record is a single JSON line with stable fields, bounded sizes, and the correlation ids of the workflow that produced it.

## Usage

```ts
import * as Observability from "@structure/observability";
import { Effect, LogLevel } from "effect";

const obs = Observability.layer({
  service: { name: "billing", version: "1.4.2" },
  logLevel: LogLevel.Info,
  logFormat: "json",            // "pretty" for local development
  otlpUrl: "http://localhost:4318", // omit → no telemetry export
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
| `makeJsonLogger(service, write?)` / `layerJson(write?)` | The structured logger; inject `write` to capture output in tests. |
| `layerPretty` / `layerSilent` / `layerMinimumLevel(level)` | Dev logger, no-logs (tests), level filter. |
| `layerOtlp({ baseUrl, headers? })` | Pure-Effect OTLP export of traces/metrics/logs (no OTel JS SDK). |
| `observabilitySettings` | Ready-made `@structure/config` settings (`LOG_LEVEL`, `LOG_FORMAT`, `OTLP_URL`). |

Telemetry export failure never takes down the workload; annotations are truncated (2 KB/string, 64 keys) so a log record can't grow unbounded.
