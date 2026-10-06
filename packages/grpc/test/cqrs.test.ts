import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import {
  layer as busLayer,
  Command,
  CommandHandler,
  HandlerRegistry,
  Query,
  QueryHandler,
} from "@structure-ai/cqrs";
import { Correlation } from "@structure-ai/observability";
import { Readiness, Shutdown } from "@structure-ai/runtime";
import { Effect, FiberRef, Layer, Schema, Stream } from "effect";
import { Probe, type Text, TextSchema } from "../examples/probe_pb.js";
import {
  GrpcCqrs,
  GrpcError,
  Metadata,
  makeClient,
  makeServer,
  Status,
  service,
} from "../src/index.js";

const identity = FiberRef.unsafeMake("outside");
const text = (value: string) => create(TextSchema, { value });
const Write = Command.define("WriteText", {
  payload: Schema.Struct({ value: Schema.String.pipe(Schema.minLength(1)) }),
  success: Schema.Struct({ value: Schema.String }),
});
const Read = Query.define("ReadText", { payload: Write.payload, success: Write.success });
const runtime = Shutdown.layer().pipe(Layer.provideMerge(Readiness.layer));
const mapping = {
  payload: (r: Text) => ({ value: r.value }),
  response: (r: { readonly value: string }) => text(r.value),
};
const unused = {
  watch: (r: Text) => Stream.succeed(r),
  upload: () => Effect.succeed(text("")),
  chat: (s: Stream.Stream<Text, GrpcError>) => s,
};

test("verification composes application context and CQRS forwards actor, correlation, idempotency and deadline", async () => {
  let writes = 0;
  const observed: { actor: string | undefined; correlation: string; identity: string }[] = [];
  const buses = busLayer.pipe(
    Layer.provide(
      HandlerRegistry.layer(
        CommandHandler.make(Write, (payload, dispatch) =>
          Effect.gen(function* () {
            writes++;
            observed.push({
              actor: dispatch.actor,
              correlation: dispatch.correlationId,
              identity: yield* FiberRef.get(identity),
            });
            if (payload.value === "slow") yield* Effect.sleep(1000);
            return payload;
          }),
        ),
        QueryHandler.make(Read, (payload) => Effect.succeed(payload)),
      ),
    ),
  );
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* makeServer(
          [service(Probe, { ...unused, unary: GrpcCqrs.command(Write, mapping) })],
          {
            address: "127.0.0.1:0",
            security: { mode: "insecure" },
            verify: (ctx) =>
              ctx.metadata.text("authorization") === "verified"
                ? Effect.succeed({
                    actor: "actor-1",
                    within: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
                      Effect.locally(effect, identity, "verified"),
                  })
                : Effect.fail(new GrpcError({ code: Status.UNAUTHENTICATED })),
          },
        );
        const client = yield* makeClient(Probe, {
          address: server.address,
          security: { mode: "insecure" },
        });
        expect((yield* client.unary(text("hello")).pipe(Effect.flip)).code).toBe(
          Status.UNAUTHENTICATED,
        );
        const metadata = new Metadata({
          authorization: "verified",
          "x-idempotency-key": "key-1",
          "x-actor": "forged",
        });
        for (let i = 0; i < 2; i++)
          yield* client
            .unary(text("hello"), { metadata })
            .pipe(Correlation.within({ correlationId: "workflow-1" }));
        expect(writes).toBe(1);
        expect(observed[0]).toEqual({
          actor: "actor-1",
          correlation: "workflow-1",
          identity: "verified",
        });
        expect(
          (yield* client
            .unary(text(""), { metadata: new Metadata({ authorization: "verified" }) })
            .pipe(Effect.flip)).code,
        ).toBe(Status.INVALID_ARGUMENT);
        expect(
          (yield* client
            .unary(text("slow"), {
              metadata: new Metadata({ authorization: "verified" }),
              timeoutMs: 30,
            })
            .pipe(Effect.flip)).code,
        ).toBe(Status.DEADLINE_EXCEEDED);
        const queries = yield* makeServer(
          [service(Probe, { ...unused, unary: GrpcCqrs.query(Read, mapping) })],
          { address: "127.0.0.1:0", security: { mode: "insecure" } },
        );
        const queryClient = yield* makeClient(Probe, {
          address: queries.address,
          security: { mode: "insecure" },
        });
        expect((yield* queryClient.unary(text("query"))).value).toBe("query");
        // Isolate the bridge's bus budget from transport cancellation.
        const budgetFailure = yield* GrpcCqrs.command(Write, mapping)(text("slow"), {
          service: Probe.typeName,
          method: "Unary",
          actor: "verified",
          correlationId: "budget-check",
          metadata: new Metadata(),
          deadline: Date.now() + 1000,
          remainingMs: Effect.succeed(15),
          sendHeaders: () => Effect.void,
          setTrailers: () => Effect.void,
        }).pipe(Effect.flip);
        expect(budgetFailure._tag).toBe("DispatchTimeout");
        if (budgetFailure._tag === "DispatchTimeout") expect(budgetFailure.timeoutMillis).toBe(15);
      }),
    ).pipe(Effect.provide(buses), Effect.provide(runtime)),
  );
});

test("server acquisition rejects ambient actor context that could authenticate unrelated callers", () =>
  Effect.runPromise(
    Effect.scoped(
      makeServer([service(Probe, { ...unused, unary: (r: Text) => Effect.succeed(r) })], {
        address: "127.0.0.1:0",
        security: { mode: "insecure" },
      }).pipe(Correlation.within({ actor: "startup-actor" }), Effect.flip),
    ).pipe(
      Effect.provide(runtime),
      Effect.tap((error) => Effect.sync(() => expect(error._tag).toBe("GrpcConfigError"))),
    ),
  ));
