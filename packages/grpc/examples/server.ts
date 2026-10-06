import { launch, Readiness, Shutdown } from "@structure-ai/runtime";
import { Effect, Layer } from "effect";
import { makeServer } from "../src/index.js";
import { probe } from "./service.js";

const runtime = Shutdown.layer().pipe(Layer.provideMerge(Readiness.layer));
launch(
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* makeServer([probe], {
        address: "127.0.0.1:50051",
        security: { mode: "insecure" },
        graceMs: 1000,
      });
      const readiness = yield* Readiness;
      yield* readiness.setReady;
      yield* Effect.log(`gRPC listening at ${server.address}`);
      const shutdown = yield* Shutdown;
      yield* shutdown.awaitShutdown;
    }),
  ),
  { layers: runtime },
);
