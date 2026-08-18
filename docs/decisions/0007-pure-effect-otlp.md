# ADR-0007: Telemetry export via the pure-Effect OTLP exporter, not the OpenTelemetry JS SDK

- Status: accepted
- Date: 2026-08-18

## Context

`@effect/opentelemetry` offers two paths: `NodeSdk` (wrapping the OpenTelemetry JS SDK, ~10 peer packages) or `Otlp.layerJson` (a pure-Effect OTLP exporter needing only an `HttpClient`).

## Decision

`@structure/observability` exports traces, metrics, and logs through `Otlp.layerJson` over `FetchHttpClient`. When no `OTLP_URL` is configured, the exporter layer is simply absent — the app runs with local logging only.

## Consequences

- The dependency tree stays small (no `@opentelemetry/*` SDK packages) and export shares Effect's fiber/span model directly.
- Telemetry export failure is bounded inside the exporter layer and cannot take down the workload.
- Anything requiring the OTel SDK's ecosystem (auto-instrumentations, exotic exporters) is out of scope; if ever needed, a `NodeSdk`-based alternative layer can sit beside this one — that addition would supersede this ADR.
