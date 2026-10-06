import { describe, expect, test } from "bun:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { Correlation } from "@structure-ai/observability";
import { Readiness, Shutdown } from "@structure-ai/runtime";
import { Cause, Chunk, Deferred, Effect, Fiber, FiberId, Layer, Schema, Stream } from "effect";
import { Probe, type Text, TextSchema } from "../examples/probe_pb.js";
import * as Grpc from "../src/index.js";

const text = (value: string) => create(TextSchema, { value });
const live = Shutdown.layer().pipe(Layer.provideMerge(Readiness.layer));
const run = <A, E>(
  effect: Effect.Effect<A, E, Readiness | Shutdown | import("effect").Scope.Scope>,
) => Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(live)));
const handlers = {
  unary: (r: Text) => Effect.succeed(text(`echo:${r.value}`)),
  watch: (_r: Text) => Stream.make(text("1"), text("2"), text("3")),
  upload: (input: Stream.Stream<Text, Grpc.GrpcError>) =>
    input.pipe(
      Stream.runCollect,
      Effect.map((values) =>
        text(
          Chunk.toArray(values)
            .map((v) => v.value)
            .join(","),
        ),
      ),
    ),
  chat: (input: Stream.Stream<Text, Grpc.GrpcError>) =>
    Stream.concat(
      Stream.succeed(text("ready")),
      Stream.map(input, (r) => text(`echo:${r.value}`)),
    ),
};
const registration = Grpc.service(Probe, handlers);
const pair = Effect.gen(function* () {
  const server = yield* Grpc.makeServer([registration], {
    address: "127.0.0.1:0",
    security: { mode: "insecure" },
  });
  const client = yield* Grpc.makeClient(Probe, {
    address: server.address,
    security: { mode: "insecure" },
  });
  return { server, client };
});

describe("native grpc", () => {
  test("typed unary and all streaming kinds preserve ordering", () =>
    run(
      Effect.gen(function* () {
        const { client } = yield* pair;
        expect((yield* client.unary(text("x"))).value).toBe("echo:x");
        expect(
          Chunk.toArray(yield* Stream.runCollect(client.watch(text("x")))).map((v) => v.value),
        ).toEqual(["1", "2", "3"]);
        expect((yield* client.upload(Stream.make(text("a"), text("b")))).value).toBe("a,b");
        expect(
          Chunk.toArray(
            yield* Stream.runCollect(client.chat(Stream.make(text("a"), text("b")))),
          ).map((v) => v.value),
        ).toEqual(["ready", "echo:a", "echo:b"]);
      }),
    ));

  test("bidi response progresses before the request producer", () =>
    run(
      Effect.gen(function* () {
        const { client } = yield* pair;
        const gate = yield* Deferred.make<void>();
        const input = Stream.fromEffect(Deferred.await(gate).pipe(Effect.as(text("later"))));
        const first = yield* client
          .chat(input)
          .pipe(Stream.take(1), Stream.runCollect, Effect.timeout("1 second"));
        expect(Chunk.toArray(first).map((v) => v.value)).toEqual(["ready"]);
      }),
    ));

  test("initial, trailing and binary metadata and sanitized correlation", () =>
    run(
      Effect.gen(function* () {
        let headers = new Grpc.Metadata();
        let trailers = new Grpc.Metadata();
        let observed = "";
        const server = yield* Grpc.makeServer(
          [
            Grpc.service(Probe, {
              ...handlers,
              unary: (_r, ctx) =>
                Effect.gen(function* () {
                  observed = (yield* Correlation.current).correlationId ?? "";
                  yield* ctx.sendHeaders(
                    new Grpc.Metadata({ hello: "world", "proof-bin": Buffer.from([1, 2]) }),
                  );
                  yield* ctx.setTrailers(new Grpc.Metadata({ done: "yes" }));
                  return text("ok");
                }),
            }),
          ],
          { address: "127.0.0.1:0", security: { mode: "insecure" } },
        );
        const client = yield* Grpc.makeClient(Probe, {
          address: server.address,
          security: { mode: "insecure" },
        });
        yield* client.unary(text("x"), {
          metadata: new Grpc.Metadata({ "x-correlation-id": "bad id" }),
          onHeaders: (v) => {
            headers = v;
          },
          onTrailers: (v) => {
            trailers = v;
          },
        });
        expect(observed).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
        expect(headers.get("x-correlation-id")).toEqual([observed]);
        expect(headers.get("hello")).toEqual(["world"]);
        expect(headers.get("proof-bin")).toEqual([Buffer.from([1, 2])]);
        expect(trailers.get("done")).toEqual(["yes"]);
      }),
    ));

  test("deadline and cancellation interrupt server effects", () =>
    run(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const stopped = yield* Deferred.make<void>();
        const server = yield* Grpc.makeServer(
          [
            Grpc.service(Probe, {
              ...handlers,
              unary: () =>
                Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() => Deferred.succeed(stopped, undefined)),
                ),
            }),
          ],
          { address: "127.0.0.1:0", security: { mode: "insecure" } },
        );
        const client = yield* Grpc.makeClient(Probe, {
          address: server.address,
          security: { mode: "insecure" },
        });
        const fiber = yield* Effect.fork(client.unary(text("x")));
        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        yield* Deferred.await(stopped).pipe(Effect.timeout("1 second"));
        const error = yield* client.unary(text("x"), { timeoutMs: 25 }).pipe(Effect.flip);
        expect(error.code).toBe(Grpc.Status.DEADLINE_EXCEEDED);
      }),
    ));

  test("server deadline bounds authentication and interrupts it independently of client timeout", () =>
    run(
      Effect.gen(function* () {
        const stopped = yield* Deferred.make<void>();
        const server = yield* Grpc.makeServer([registration], {
          address: "127.0.0.1:0",
          security: { mode: "insecure" },
          maxCallMs: 25,
          verify: () =>
            Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(stopped, undefined))),
        });
        const client = yield* Grpc.makeClient(Probe, {
          address: server.address,
          security: { mode: "insecure" },
          timeoutMs: 1000,
        });
        expect((yield* client.unary(text("x")).pipe(Effect.flip)).code).toBe(
          Grpc.Status.DEADLINE_EXCEEDED,
        );
        yield* Deferred.await(stopped).pipe(Effect.timeout("1 second"));
        expect(yield* server.activeCalls).toBe(0);
      }),
    ));

  test("stream failure after a message remains a terminal failure and is safely rendered", () =>
    run(
      Effect.gen(function* () {
        const server = yield* Grpc.makeServer(
          [
            Grpc.service(Probe, {
              ...handlers,
              watch: () =>
                Stream.concat(
                  Stream.fromIterable(Array.from({ length: 32 }, (_, i) => text(String(i)))),
                  Stream.fail({ secret: "do-not-send", stack: "internal" }),
                ),
            }),
          ],
          { address: "127.0.0.1:0", security: { mode: "insecure" } },
        );
        const client = yield* Grpc.makeClient(Probe, {
          address: server.address,
          security: { mode: "insecure" },
        });
        const seen: string[] = [];
        const error = yield* client.watch(text("x")).pipe(
          Stream.tap((r) =>
            Effect.sync(() => seen.push(r.value)).pipe(Effect.andThen(Effect.sleep(5))),
          ),
          Stream.runDrain,
          Effect.flip,
        );
        expect(seen).toEqual(Array.from({ length: 32 }, (_, i) => String(i)));
        expect(error.code).toBe(Grpc.Status.INTERNAL);
        expect(error.message).not.toContain("do-not-send");
        expect(error.message).not.toContain("internal");
      }),
    ));

  test("an established stream deadline interrupts the server stream and its finalizers", () =>
    run(
      Effect.gen(function* () {
        const stopped = yield* Deferred.make<void>();
        const server = yield* Grpc.makeServer(
          [
            Grpc.service(Probe, {
              ...handlers,
              watch: () =>
                Stream.concat(Stream.succeed(text("first")), Stream.fromEffect(Effect.never)).pipe(
                  Stream.ensuring(Deferred.succeed(stopped, undefined)),
                ),
            }),
          ],
          { address: "127.0.0.1:0", security: { mode: "insecure" } },
        );
        const client = yield* Grpc.makeClient(Probe, {
          address: server.address,
          security: { mode: "insecure" },
        });
        const seen: string[] = [];
        const error = yield* client.watch(text("x"), { timeoutMs: 30 }).pipe(
          Stream.tap((v) => Effect.sync(() => seen.push(v.value))),
          Stream.runDrain,
          Effect.flip,
        );
        expect(seen).toEqual(["first"]);
        expect(error.code).toBe(Grpc.Status.DEADLINE_EXCEEDED);
        yield* Deferred.await(stopped).pipe(Effect.timeout("1 second"));
      }),
    ));

  test("declared business failures use their explicit codec", () =>
    run(
      Effect.gen(function* () {
        const failure = Grpc.businessFailure(
          Schema.Struct({ _tag: Schema.Literal("Rejected"), reason: Schema.String }),
          {
            encode: (value) => toBinary(TextSchema, text(value.reason)),
            decode: (bytes) => ({
              _tag: "Rejected" as const,
              reason: fromBinary(TextSchema, bytes).value,
            }),
          },
        );
        const failures = { unary: failure };
        const server = yield* Grpc.makeServer(
          [
            Grpc.service(
              Probe,
              {
                ...handlers,
                unary: () =>
                  Effect.fail({ _tag: "Rejected" as const, reason: "sold out", secret: "hidden" }),
              },
              { failures },
            ),
          ],
          { address: "127.0.0.1:0", security: { mode: "insecure" } },
        );
        const client = yield* Grpc.makeClient(Probe, {
          address: server.address,
          security: { mode: "insecure" },
          failures,
        });
        expect(yield* client.unary(text("x")).pipe(Effect.flip)).toEqual({
          _tag: "Rejected",
          reason: "sold out",
        });
      }),
    ));

  test("configuration rejects unbounded limits before binding", () =>
    run(
      Effect.gen(function* () {
        const error = yield* Grpc.makeServer([registration], {
          address: "127.0.0.1:0",
          security: { mode: "insecure" },
          maxReceiveBytes: -1,
        }).pipe(Effect.flip);
        expect(error._tag).toBe("GrpcConfigError");
      }),
    ));

  test("business failures never hide defects or interruption in compound causes", () =>
    run(
      Effect.gen(function* () {
        const failure = Grpc.businessFailure(Schema.Struct({ _tag: Schema.Literal("Rejected") }), {
          encode: () => new Uint8Array(),
          decode: () => ({ _tag: "Rejected" as const }),
        });
        const server = yield* Grpc.makeServer(
          [
            Grpc.service(
              Probe,
              {
                ...handlers,
                unary: (r) =>
                  Effect.failCause(
                    Cause.parallel(
                      Cause.fail({ _tag: "Rejected" as const }),
                      r.value === "defect"
                        ? Cause.die(new Error("private detail"))
                        : Cause.interrupt(FiberId.none),
                    ),
                  ),
              },
              { failures: { unary: failure } },
            ),
          ],
          {
            address: "127.0.0.1:0",
            security: { mode: "insecure" },
          },
        );
        const client = yield* Grpc.makeClient(Probe, {
          address: server.address,
          security: { mode: "insecure" },
          failures: { unary: failure },
        });
        for (const [input, code] of [
          ["defect", Grpc.Status.INTERNAL],
          ["cancel", Grpc.Status.CANCELLED],
        ] as const) {
          const error = yield* client.unary(text(input)).pipe(Effect.flip);
          expect(error).toBeInstanceOf(Grpc.GrpcError);
          if (error instanceof Grpc.GrpcError) expect(error.code).toBe(code);
        }
      }),
    ));

  test("typed terminal stream failures preserve prior messages; oversized wire failures stay safe", () =>
    run(
      Effect.gen(function* () {
        const failure = Grpc.businessFailure(
          Schema.Struct({ _tag: Schema.Literal("Rejected"), reason: Schema.String }),
          {
            encode: (v) => toBinary(TextSchema, text(v.reason)),
            decode: (b) => ({ _tag: "Rejected" as const, reason: fromBinary(TextSchema, b).value }),
          },
        );
        const failures = { watch: failure, unary: failure };
        const server = yield* Grpc.makeServer(
          [
            Grpc.service(
              Probe,
              {
                ...handlers,
                watch: () =>
                  Stream.concat(
                    Stream.succeed(text("first")),
                    Stream.fail({ _tag: "Rejected" as const, reason: "closed", secret: "hidden" }),
                  ),
                unary: () => Effect.fail({ _tag: "Rejected" as const, reason: "x".repeat(9000) }),
              },
              { failures },
            ),
          ],
          { address: "127.0.0.1:0", security: { mode: "insecure" } },
        );
        const client = yield* Grpc.makeClient(Probe, {
          address: server.address,
          security: { mode: "insecure" },
          failures,
        });
        const seen: string[] = [];
        const error = yield* client.watch(text("x")).pipe(
          Stream.tap((v) => Effect.sync(() => seen.push(v.value))),
          Stream.runDrain,
          Effect.flip,
        );
        expect(seen).toEqual(["first"]);
        expect(error).toEqual({ _tag: "Rejected", reason: "closed" });
        const oversized = yield* client.unary(text("x")).pipe(Effect.flip);
        expect(oversized).toBeInstanceOf(Grpc.GrpcError);
        if (oversized instanceof Grpc.GrpcError) expect(oversized.code).toBe(Grpc.Status.INTERNAL);
        const invalid = yield* failure.decode(new Uint8Array([0xff])).pipe(Effect.flip);
        expect(invalid.code).toBe(Grpc.Status.INTERNAL);
      }),
    ));

  test("shutdown stops admission and interrupts calls exceeding the grace period", () =>
    run(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const stopped = yield* Deferred.make<void>();
        const server = yield* Grpc.makeServer(
          [
            Grpc.service(Probe, {
              ...handlers,
              unary: () =>
                Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() => Deferred.succeed(stopped, undefined)),
                ),
            }),
          ],
          { address: "127.0.0.1:0", security: { mode: "insecure" }, graceMs: 30 },
        );
        const client = yield* Grpc.makeClient(Probe, {
          address: server.address,
          security: { mode: "insecure" },
        });
        const fiber = yield* Effect.fork(client.unary(text("x")).pipe(Effect.either));
        yield* Deferred.await(started);
        const shutdown = yield* Shutdown;
        yield* shutdown.trigger("test").pipe(Effect.timeout("1 second"));
        yield* Deferred.await(stopped).pipe(Effect.timeout("1 second"));
        yield* Fiber.join(fiber);
        expect(yield* server.isAccepting).toBe(false);
        expect(yield* server.activeCalls).toBe(0);
      }),
    ));
});
