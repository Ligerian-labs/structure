import { layer as busLayer, Command, CommandHandler, HandlerRegistry } from "@structure-ai/cqrs";
import { Readiness, Shutdown } from "@structure-ai/runtime";
import { Effect, Layer, Schema } from "effect";
import { GrpcCqrs, makeClient, makeServer, service } from "../src/index.js";
import { Probe, type Text } from "./probe_pb.js";
import { handlers, text } from "./service.js";

const Echo = Command.define("EchoText", {
  payload: Schema.Struct({ value: Schema.String }),
  success: Schema.Struct({ value: Schema.String }),
});
const buses = busLayer.pipe(
  Layer.provide(
    HandlerRegistry.layer(CommandHandler.make(Echo, (payload) => Effect.succeed(payload))),
  ),
);
const runtime = Shutdown.layer().pipe(Layer.provideMerge(Readiness.layer));
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const registration = service(Probe, {
        ...handlers,
        unary: GrpcCqrs.command(Echo, {
          payload: (r: Text) => ({ value: r.value }),
          response: (r) => text(r.value),
        }),
      });
      const server = yield* makeServer([registration], {
        address: "127.0.0.1:0",
        security: { mode: "insecure" },
      });
      const client = yield* makeClient(Probe, {
        address: server.address,
        security: { mode: "insecure" },
      });
      console.log((yield* client.unary(text("through the bus"))).value);
    }),
  ).pipe(Effect.provide(buses), Effect.provide(runtime)),
);
