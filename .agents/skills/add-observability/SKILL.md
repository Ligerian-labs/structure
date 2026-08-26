---
name: add-observability
description: Wire structured logging, correlation ids, metrics, and OTLP telemetry in a @structure-based app. Use when adding logging, tracing, or metrics to an effect.
---

# Add observability

One layer wires the full stack: JSON-line structured logs with stable fields and correlation ids, traffic/error/latency metrics per named boundary, and optional OTLP export of traces, metrics, and logs — pure Effect, no OTel JS SDK. Reference: `packages/observability/README.md`.

## Steps

1. **Provide the stack** once, at the composition root:

```ts
import * as Observability from "@structure-ai/observability";
import { LogLevel } from "effect";

const obs = Observability.layer({
  service: { name: "billing", version: "1.4.2" },
  logLevel: LogLevel.Info,
  logFormat: "json",                 // "pretty" for local development
  otlpUrl: "http://localhost:4318",  // omit → no telemetry export
});
```

   Drive it from settings with `observabilitySettings` (`LOG_LEVEL`, `LOG_FORMAT`, `OTLP_URL`) plus `@structure-ai/config`.

2. **Correlate work**: `Observability.Correlation.within({ requestId })` merges ids onto the fiber (logs and spans pick them up); `Correlation.scoped()` mints a `correlationId` when the caller has none — use it at entry points (HTTP middleware does this already via `@structure-ai/http`).
3. **Measure boundaries**: `Observability.Metrics.track("billing_accept")` wraps an effect with a span plus calls/errors/latency metrics. Wrap transport edges and handlers, not inner loops.
4. **In tests**, inject the writer (`layerJson(write)` to capture records) or use `layerSilent`; assert on fields, never on formatted strings.
5. **Tests:** follow `packages/observability/test/observability.test.ts`.

## Rules

- Never log secrets, tokens, or prompt bodies; annotations are truncated (2 KB/string, 64 keys) as a backstop, not a license.
- Log through the structured logger with message + fields; the JSON line shape is the contract that log tooling consumes.
- Telemetry export failure never propagates to the workload — don't wrap exporters in business-path retries.
- Every service/process gets `ServiceMeta` (name/version) — records without service identity are unqueryable in aggregate.

## Verify

`bun x tsc --noEmit && bun test` in the package.
