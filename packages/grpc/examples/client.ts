import { Effect, Stream } from "effect";
import { makeClient } from "../src/index.js";
import { Probe } from "./probe_pb.js";
import { text } from "./service.js";

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* makeClient(Probe, {
        address: "127.0.0.1:50051",
        security: { mode: "insecure" },
      });
      console.log((yield* client.unary(text("hello"))).value);
      yield* client
        .watch(text("watch"))
        .pipe(Stream.runForEach((r) => Effect.sync(() => console.log(r.value))));
      console.log((yield* client.upload(Stream.make(text("a"), text("b")))).value);
      yield* client
        .chat(Stream.make(text("a"), text("b")))
        .pipe(Stream.runForEach((r) => Effect.sync(() => console.log(r.value))));
    }),
  ),
);
