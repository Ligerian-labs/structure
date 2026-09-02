// Launched as a subprocess by runtime.test.ts: the README program, verbatim in
// spirit — register finalizers, become ready, block on `awaitShutdown`. The
// test sends SIGTERM once "ready" appears and reads the lines below.
import { layerSilent } from "@structure-ai/observability";
import { Effect, Layer } from "effect";
import { launch, Readiness, Shutdown } from "../../src/index.js";

const say = (line: string) => Effect.sync(() => console.log(line));

const program = Effect.gen(function* () {
  const readiness = yield* Readiness;
  const shutdown = yield* Shutdown;
  for (const name of ["close-db", "drain-jobs"]) {
    yield* shutdown.onShutdown(
      name,
      Effect.gen(function* () {
        const ready = yield* readiness.isReady;
        yield* say(`finalizer ${name} ready=${ready}`);
      }),
    );
  }
  yield* readiness.setReady;
  yield* say("ready");
  const reason = yield* shutdown.awaitShutdown;
  yield* say(`shutdown ${reason}`);
});

launch(program, {
  layers: Layer.mergeAll(Layer.provideMerge(Shutdown.layer(), Readiness.layer), layerSilent),
});
