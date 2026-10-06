import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { create } from "@bufbuild/protobuf";
import { credentials, Client as NativeClient, Metadata as NativeMetadata } from "@grpc/grpc-js";
import { Readiness, Shutdown } from "@structure-ai/runtime";
import { Chunk, Deferred, Effect, Fiber, Layer, Redacted, Stream } from "effect";
import { Probe, type Text, TextSchema } from "../examples/probe_pb.js";
import { GrpcError, makeClient, makeServer, Status, service, toStatus } from "../src/index.js";
import { readRaw } from "../src/internal.js";

const text = (value: string) => create(TextSchema, { value });
const handlers = {
  unary: (r: Text) => Effect.succeed(r),
  watch: (r: Text) => Stream.succeed(r),
  upload: () => Effect.succeed(text("")),
  chat: (s: Stream.Stream<Text, GrpcError>) => s,
};
const runtime = Shutdown.layer().pipe(Layer.provideMerge(Readiness.layer));
const run = <A, E>(
  effect: Effect.Effect<A, E, Readiness | Shutdown | import("effect").Scope.Scope>,
) => Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(runtime)));

// Wait for transport windows to fill, then require a plateau while the consumer stays blocked.
const stoppedProducing = (count: () => number) =>
  Effect.gen(function* () {
    let previous = count();
    let stable = 0;
    while (stable < 3) {
      yield* Effect.sleep(25);
      const current = count();
      expect(current).toBeLessThan(128);
      stable = current === previous ? stable + 1 : 0;
      previous = current;
    }
    expect(previous).toBeGreaterThan(0);
    yield* Effect.sleep(100);
    expect(count()).toBe(previous);
  }).pipe(Effect.timeout("2 seconds"));

test("repeated scoped reads release listeners after early completion and errors", async () => {
  const source = new PassThrough({ objectMode: true });
  const events = ["readable", "end", "error", "close"];
  const baseline = events.map((event) => source.listenerCount(event));
  for (let i = 0; i < 20; i++) {
    source.write(i);
    await Effect.runPromise(readRaw(source).pipe(Stream.take(1), Stream.runDrain));
    expect(events.map((event) => source.listenerCount(event))).toEqual(baseline);
  }
  const timer = setTimeout(() => source.emit("error", new Error("fixture failure")), 5);
  try {
    await Effect.runPromise(readRaw(source).pipe(Stream.runDrain, Effect.either));
    expect(events.map((event) => source.listenerCount(event))).toEqual(baseline);
  } finally {
    clearTimeout(timer);
    source.destroy();
  }
});

test("decoded readable buffers drain in order before a terminal error", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const source = new PassThrough({ objectMode: true });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            source.destroy();
          }),
        );
        const first = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        for (let i = 0; i < 48; i++) source.write(i);
        const values: unknown[] = [];
        const fiber = yield* readRaw(source).pipe(
          Stream.tap((v) =>
            Effect.sync(() => values.push(v)).pipe(
              Effect.andThen(
                Deferred.succeed(first, undefined).pipe(Effect.andThen(Deferred.await(gate))),
              ),
            ),
          ),
          Stream.runDrain,
          Effect.either,
          Effect.fork,
        );
        yield* Deferred.await(first);
        source.emit("error", new Error("terminal failure"));
        yield* Deferred.succeed(gate, undefined);
        const result = yield* Fiber.join(fiber);
        expect(result._tag).toBe("Left");
        expect(values).toEqual(Chunk.toArray(Chunk.range(0, 47)));
      }),
    ),
  ));

test(
  "slow consumers bound production and stream cancellation interrupts server finalizers",
  () =>
    run(
      Effect.gen(function* () {
        const first = yield* Deferred.make<void>();
        const stop = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        let produced = 0;
        const server = yield* makeServer(
          [
            service(Probe, {
              ...handlers,
              watch: () =>
                Stream.repeatEffect(
                  Effect.sync(() => {
                    produced++;
                    return text("x".repeat(256 * 1024));
                  }),
                ).pipe(Stream.ensuring(Deferred.succeed(stop, undefined))),
            }),
          ],
          { address: "127.0.0.1:0", security: { mode: "insecure" } },
        );
        const client = yield* makeClient(Probe, {
          address: server.address,
          security: { mode: "insecure" },
          bufferSize: 1,
        });
        const fiber = yield* client.watch(text("x")).pipe(
          Stream.tap(() =>
            Deferred.succeed(first, undefined).pipe(Effect.andThen(Deferred.await(gate))),
          ),
          Stream.runDrain,
          Effect.fork,
        );
        yield* Deferred.await(first);
        yield* stoppedProducing(() => produced);
        yield* Fiber.interrupt(fiber);
        yield* Deferred.await(stop).pipe(Effect.timeout("1 second"));
      }),
    ),
  5000,
);

test("a server that stops reading backpressures a client producer and releases it on cancellation", () =>
  run(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();
      let produced = 0;
      const server = yield* makeServer(
        [
          service(Probe, {
            ...handlers,
            upload: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          }),
        ],
        { address: "127.0.0.1:0", security: { mode: "insecure" } },
      );
      const client = yield* makeClient(Probe, {
        address: server.address,
        security: { mode: "insecure" },
      });
      const input = Stream.repeatEffect(
        Effect.sync(() => {
          produced++;
          return text("x".repeat(256 * 1024));
        }),
      ).pipe(Stream.ensuring(Deferred.succeed(stopped, undefined)));
      const fiber = yield* Effect.fork(client.upload(input));
      yield* Deferred.await(started);
      yield* stoppedProducing(() => produced);
      yield* Fiber.interrupt(fiber);
      yield* Deferred.await(stopped).pipe(Effect.timeout("1 second"));
    }),
  ));

test("client input failure propagates and releases client-streaming and bidi calls", () =>
  run(
    Effect.gen(function* () {
      const server = yield* makeServer(
        [
          service(Probe, {
            ...handlers,
            upload: (s) => s.pipe(Stream.runDrain, Effect.as(text("done"))),
          }),
        ],
        { address: "127.0.0.1:0", security: { mode: "insecure" } },
      );
      const client = yield* makeClient(Probe, {
        address: server.address,
        security: { mode: "insecure" },
      });
      const input = Stream.concat(Stream.succeed(text("one")), Stream.fail("producer failed"));
      expect(yield* client.upload(input).pipe(Effect.flip)).toBe("producer failed");
      expect(yield* client.chat(input).pipe(Stream.runDrain, Effect.flip)).toBe("producer failed");
      yield* server.close;
      expect(yield* server.activeCalls).toBe(0);
    }),
  ));

test("message limits reject oversized requests/responses and malformed protobuf is INVALID_ARGUMENT", () =>
  run(
    Effect.gen(function* () {
      const server = yield* makeServer(
        [
          service(Probe, {
            ...handlers,
            unary: (r) => Effect.succeed(text(r.value === "large" ? "x".repeat(1000) : r.value)),
          }),
        ],
        {
          address: "127.0.0.1:0",
          security: { mode: "insecure" },
          maxReceiveBytes: 64,
          maxSendBytes: 64,
        },
      );
      const client = yield* makeClient(Probe, {
        address: server.address,
        security: { mode: "insecure" },
      });
      expect((yield* client.unary(text("x".repeat(1000))).pipe(Effect.flip)).code).toBe(
        Status.RESOURCE_EXHAUSTED,
      );
      expect((yield* client.unary(text("large")).pipe(Effect.flip)).code).toBe(
        Status.RESOURCE_EXHAUSTED,
      );
      const raw = yield* Effect.acquireRelease(
        Effect.sync(() => new NativeClient(server.address, credentials.createInsecure())),
        (c) => Effect.sync(() => c.close()),
      );
      const error = yield* Effect.async<never, { code: number }>((resume) => {
        raw.makeUnaryRequest(
          "/structure.probe.Probe/Unary",
          () => Buffer.from([0xff]),
          (b) => b,
          null,
          new NativeMetadata(),
          { deadline: Date.now() + 1000 },
          (error) => {
            resume(Effect.fail({ code: error?.code ?? 0 }));
          },
        );
      }).pipe(Effect.flip);
      expect(error.code).toBe(Status.INVALID_ARGUMENT);
    }),
  ));

test("TLS validates trust and supports mutual authentication", async () => {
  const certificate = new Uint8Array(
    await Bun.file(new URL("./fixtures/tls-cert.pem", import.meta.url)).arrayBuffer(),
  );
  const privateKey = Redacted.make(
    new Uint8Array(
      await Bun.file(new URL("./fixtures/tls-key.pem", import.meta.url)).arrayBuffer(),
    ),
  );
  await run(
    Effect.gen(function* () {
      const server = yield* makeServer([service(Probe, handlers)], {
        address: "127.0.0.1:0",
        security: {
          mode: "tls",
          certificate,
          privateKey,
          ca: certificate,
          requireClientCertificate: true,
        },
      });
      const authenticated = yield* makeClient(Probe, {
        address: server.address,
        security: {
          mode: "tls",
          serverName: "localhost",
          ca: certificate,
          certificate,
          privateKey,
        },
      });
      expect((yield* authenticated.unary(text("encrypted"))).value).toBe("encrypted");
      const untrusted = yield* makeClient(Probe, {
        address: server.address,
        security: { mode: "tls", serverName: "localhost" },
      });
      expect(
        (yield* untrusted.unary(text("secret"), { timeoutMs: 100 }).pipe(Effect.flip)).code,
      ).toBe(Status.UNAVAILABLE);
      const noCertificate = yield* makeClient(Probe, {
        address: server.address,
        security: { mode: "tls", serverName: "localhost", ca: certificate },
      });
      expect(
        (yield* noCertificate.unary(text("secret"), { timeoutMs: 100 }).pipe(Effect.flip)).code,
      ).toBe(Status.UNAVAILABLE);
    }),
  );
});

test("shutdown drains a completing call and closes the listener; acquisition can reuse its address", () =>
  run(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const server = yield* makeServer(
        [
          service(Probe, {
            ...handlers,
            unary: () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(gate)),
                Effect.as(text("drained")),
              ),
          }),
        ],
        { address: "127.0.0.1:0", security: { mode: "insecure" }, graceMs: 1000 },
      );
      const client = yield* makeClient(Probe, {
        address: server.address,
        security: { mode: "insecure" },
      });
      const call = yield* Effect.fork(client.unary(text("x")));
      yield* Deferred.await(started);
      const closing = yield* Effect.fork(server.close);
      yield* Effect.sleep(5);
      expect(yield* server.isAccepting).toBe(false);
      yield* Deferred.succeed(gate, undefined);
      expect((yield* Fiber.join(call)).value).toBe("drained");
      yield* Fiber.join(closing);
      const replacement = yield* makeServer([service(Probe, handlers)], {
        address: server.address,
        security: { mode: "insecure" },
      });
      expect(yield* replacement.isAccepting).toBe(true);
    }),
  ));

test("framework status mapping validates contracts and never arbitrary tags/messages/codes", () => {
  const cases: ReadonlyArray<readonly [unknown, number]> = [
    [{ _tag: "ValidationFailed", subject: "Test", issues: ["invalid"] }, Status.INVALID_ARGUMENT],
    [{ _tag: "Unauthenticated" }, Status.UNAUTHENTICATED],
    [
      { _tag: "PermissionDenied", permission: "read", principal: "actor" },
      Status.PERMISSION_DENIED,
    ],
    [{ _tag: "Unauthorized", tag: "Test" }, Status.PERMISSION_DENIED],
    [
      {
        _tag: "ConcurrencyConflict",
        entity: "Test",
        id: "1",
        expectedVersion: 1,
        actualVersion: 2,
      },
      Status.ABORTED,
    ],
    [{ _tag: "DispatchTimeout", tag: "Test", timeoutMillis: 10 }, Status.DEADLINE_EXCEEDED],
    [{ _tag: "IdempotencyInFlight", tag: "Test", key: "key" }, Status.UNAVAILABLE],
  ];
  for (const [error, code] of cases) expect(toStatus(error)).toBe(code);
  for (const error of [
    { _tag: "ValidationFailed" },
    { _tag: "ParseError" },
    { _tag: "PermissionDenied", permission: 12 },
  ])
    expect(toStatus(error)).toBe(Status.INTERNAL);
  expect(toStatus({ code: 3, message: "secret" })).toBe(Status.INTERNAL);
  expect(new GrpcError({ code: Status.UNAVAILABLE }).classification).toBe("transient");
  expect(new GrpcError({ code: Status.ABORTED }).classification).toBe("conflict");
  expect(new GrpcError({ code: Status.PERMISSION_DENIED }).classification).toBe("permanent");
});

test("global handler capacity rejects work across independent channels", () =>
  run(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      let calls = 0;
      const server = yield* makeServer(
        [
          service(Probe, {
            ...handlers,
            unary: () =>
              Effect.gen(function* () {
                calls++;
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(gate);
                return text("ok");
              }),
          }),
        ],
        { address: "127.0.0.1:0", security: { mode: "insecure" }, maxActiveCalls: 1 },
      );
      const first = yield* makeClient(Probe, {
        address: server.address,
        security: { mode: "insecure" },
      });
      const second = yield* makeClient(Probe, {
        address: server.address,
        security: { mode: "insecure" },
      });
      const call = yield* Effect.fork(first.unary(text("one")));
      yield* Deferred.await(started);
      expect((yield* second.unary(text("two")).pipe(Effect.flip)).code).toBe(
        Status.RESOURCE_EXHAUSTED,
      );
      expect(calls).toBe(1);
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(call);
    }),
  ));

test("a client retained after its resource scope fails safely", () =>
  run(
    Effect.gen(function* () {
      const server = yield* makeServer([service(Probe, handlers)], {
        address: "127.0.0.1:0",
        security: { mode: "insecure" },
      });
      const client = yield* Effect.scoped(
        makeClient(Probe, { address: server.address, security: { mode: "insecure" } }),
      );
      expect((yield* client.unary(text("closed")).pipe(Effect.flip)).code).toBe(Status.UNAVAILABLE);
    }),
  ));
