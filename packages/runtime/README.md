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
  yield* shutdown.awaitShutdown; // resolves with "SIGTERM"/"SIGINT"/the trigger() reason, after the finalizers drained
});

launch(program, {
  layers: Layer.provideMerge(Shutdown.layer(), Readiness.layer),
  gracePeriod: Duration.seconds(30),
});
```

## Shutdown path

`launch` routes SIGTERM/SIGINT into the coordinator when the layers provide `Shutdown`: the signal becomes `trigger("SIGTERM")`, readiness flips unready, finalizers drain in reverse registration order (each under its timeout, on a daemon fiber so an interruption cannot cut the drain short), `awaitShutdown` resolves with the signal name, the program ends, layers tear down (`@structure-ai/http`'s `serve` drops its listener here), and the process exits 0. A program that never ends by itself (`Effect.never`-style servers) is interrupted once the drain completed. `runMain`'s own reaction to the signal — interrupting the main fiber — is bridged to `trigger("interrupted")` and awaited, so the two listeners can fire in any order; the reason is the signal name whenever the signal is seen first, which is the normal case. A second signal ends the process immediately (default OS behavior); `gracePeriod` bounds the whole teardown.

`trigger` is idempotent and every call returns once the drain completed; `awaitShutdown` does the same and yields the reason. Put shutdown work in `onShutdown` finalizers, not after `awaitShutdown`: once it resolves the program is expected to end.

`runToCompletion(program, layers, { signal? })` never observes OS signals: `signal` (typically `Deferred.await(stop)`) injects a reason exactly as SIGTERM would under `launch`, and interrupting the returned effect drains the coordinator too. A program stopped through the shutdown path is reported as `Success`, matching the exit code 0 `launch` produces.

Calling `BunRuntime.runMain` yourself instead of `launch`? Then nothing routes signals to the coordinator: bridge the interruption `runMain` performs with `program.pipe(Effect.onInterrupt(() => shutdown.trigger("interrupted")))`.

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
