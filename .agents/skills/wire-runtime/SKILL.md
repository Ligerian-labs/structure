---
name: wire-runtime
description: Wire an application entrypoint in a @structure-based app - config-first startup, readiness checks, graceful shutdown, deterministic exit. Use when creating or changing a process entrypoint.
---

# Wire the runtime

The production contract for a process: load and validate configuration first (report **all** issues, exit non-zero before accepting work), then telemetry, then resources; on shutdown mark unready, drain finalizers in reverse order within a bounded grace period, exit deterministically. Reference: `packages/runtime/README.md`.

## Steps

1. **Write the program** around `Readiness` + `Shutdown`:

```ts
import { launch, Readiness, Shutdown } from "@structure-ai/runtime";
import { Duration, Effect, Layer } from "effect";

const program = Effect.gen(function* () {
  const shutdown = yield* Shutdown;
  yield* shutdown.onShutdown("close-db", closeDb);   // reverse order, each ≤ timeout
  yield* Readiness.setReady;                        // starts NOT ready
  yield* shutdown.awaitShutdown;                    // SIGINT/SIGTERM or trigger()
});
```

2. **Register dependency checks** on `Readiness` (db reachable, queue connected) — `/health/ready` from `@structure-ai/http` reports them by name; a check defect reports `ok: false`, never crashes the probe.
3. **Launch** with layers and a hard grace-period deadline: `launch(program, { layers, gracePeriod: Duration.seconds(30) })`. `ConfigLoadError` prints every issue and exits 1.
4. **Prefer layers over imperative cleanup**: put resources in `Layer.scoped` so finalizers compose with shutdown automatically; use `onShutdown` only for resources acquired outside the Effect world.
5. **Tests:** `runToCompletion(program, layers)` returns `{ _tag: "Success" | "ConfigInvalid" | "Failed", ... }` instead of exiting. Follow `packages/runtime/test/runtime.test.ts`.

## Rules

- Every resource gets a finalizer; a slow or failing one is logged and skipped, bounded by its timeout — don't rely on teardown that can hang.
- Set ready only after the process can actually serve; anything registered before that reports not-ready, which is correct.
- Entrypoints compose the layers; layer wiring (config → observability → stores → http) is the whole startup order.
- Never `process.exit` inside library or handler code — exit policy belongs to `launch`/`runToCompletion`.

## Verify

`bun x tsc --noEmit && bun test` in the package.
