# @structure-ai/runtime

Application bootstrap per the production contract: load and validate configuration first (reporting **all** issues, exiting non-zero before accepting work), then telemetry, then resources; on shutdown mark unready, drain finalizers in reverse order within a bounded grace period, exit deterministically.

## Usage

```ts
import { launch, Readiness, Shutdown } from "@structure-ai/runtime";
import { Duration, Effect, Layer } from "effect";

const program = Effect.gen(function* () {
  const readiness = yield* Readiness;
  const shutdown = yield* Shutdown;
  yield* shutdown.onShutdown("close-db", closeDb);
  yield* readiness.setReady;
  yield* shutdown.awaitShutdown; // block until SIGINT/SIGTERM or trigger()
});

launch(program, {
  layers: Layer.provideMerge(Shutdown.layer(), Readiness.layer),
  gracePeriod: Duration.seconds(30),
});
```

## Exports

| Export | What it is |
| --- | --- |
| `Readiness` / `Readiness.layer` | Ready flag + named checks; `checkAll` is ready only when the flag is set and every registered check passes; check defects report `ok: false`, never crash. Starts **not** ready. |
| `Shutdown` / `Shutdown.layer(options?)` | Coordinator: `onShutdown(name, finalizer)`, idempotent `trigger(reason)`, `awaitShutdown`. Finalizers run in reverse registration order, each bounded by a timeout (default 5s); a slow/failing finalizer is logged and skipped. Triggering flips `Readiness` unready first. |
| `launch(program, { layers, gracePeriod? })` | Bun entrypoint (`BunRuntime.runMain` with `disablePrettyLogger`); `ConfigLoadError` prints every issue and exits 1; a hard deadline (default 30s) prevents hung teardown from blocking exit. |
| `runToCompletion(program, layers)` | Testable variant returning `{ _tag: "Success" \| "ConfigInvalid" \| "Failed", ... }` instead of exiting the process. |

`@structure-ai/http`'s `/health/ready` endpoint consumes `Readiness.checkAll`.

## Operations

**One logger per process.** `launch` runs `BunRuntime.runMain` with `disablePrettyLogger: true`, so the app decides its logger through `@structure-ai/observability` (`layerJson` in production, `layerPretty` locally). Without it `runMain` installs Bun's pretty logger before any app layer runs and the JSON logger lands next to it — every record printed twice. If you call `runMain` yourself, pass the same option; `layerJson` also removes the pretty logger as a backstop, so a plain-`runMain` app with `layerJson` still ends up with a single logger.
