import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Correlation, Metrics, makeJsonLogger } from "@structure-ai/observability";
import { Readiness, Shutdown } from "@structure-ai/runtime";
import { Effect, Layer, Logger, LogLevel, Metric, MetricLabel, Stream, Tracer } from "effect";
import { Probe, TextSchema } from "../examples/probe_pb.js";
import { GrpcError, Metadata, makeClient, makeServer, Status, service } from "../src/index.js";

const runtime = Shutdown.layer().pipe(Layer.provideMerge(Readiness.layer));
test("boundaries record bounded labels, spans and correlated logs without bodies or credentials", async () => {
  const lines: string[] = [];
  const logger = makeJsonLogger({ name: "grpc-test", version: "0", instance: "test" }, (line) =>
    lines.push(line),
  );
  const tags = [
    MetricLabel.make("service", Probe.typeName),
    MetricLabel.make("method", "Unary"),
    MetricLabel.make("status", "UNAVAILABLE"),
  ];
  const errors = Metric.taggedWithLabels(Metrics.boundary("grpc_server").errors, tags);
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const before = yield* Metrics.counterValue(errors);
        let span = "";
        const server = yield* makeServer(
          [
            service(Probe, {
              unary: () =>
                Effect.gen(function* () {
                  span = (yield* Effect.currentSpan).name;
                  return yield* Effect.fail(new GrpcError({ code: Status.UNAVAILABLE }));
                }),
              watch: (r) => Stream.succeed(r),
              upload: () => Effect.succeed(create(TextSchema)),
              chat: (s) => s,
            }),
          ],
          { address: "127.0.0.1:0", security: { mode: "insecure" } },
        );
        const client = yield* makeClient(Probe, {
          address: server.address,
          security: { mode: "insecure" },
        });
        yield* client
          .unary(create(TextSchema, { value: "message-secret" }), {
            metadata: new Metadata({
              authorization: "credential-secret",
              "custom-bin": Buffer.from("metadata-secret"),
            }),
          })
          .pipe(Effect.either, Correlation.within({ correlationId: "telemetry-workflow" }));
        expect(yield* Metrics.counterValue(errors)).toBe(Number(before) + 1);
        expect(span).toBe("grpc.server");
      }),
    ).pipe(
      Effect.provide(runtime),
      Effect.provide(Logger.replace(Logger.defaultLogger, logger)),
      Effect.provide(Logger.minimumLogLevel(LogLevel.Debug)),
    ),
  );
  const encoded = lines.join("\n");
  for (const forbidden of ["message-secret", "credential-secret", "metadata-secret"])
    expect(encoded).not.toContain(forbidden);
  expect(encoded).toContain("grpc server completed");
  expect(encoded).toContain("grpc client completed");
  expect(encoded).toContain("telemetry-workflow");
});

test("boundary span completion never exports raw failures or stream messages", () =>
  Effect.runPromise(
    Tracer.tracerWith((original) => {
      const ended: string[] = [];
      const tracer = Tracer.make({
        context: (execute, fiber) => original.context(execute, fiber),
        span: (...args) => {
          const span = original.span(...args);
          const finish = span.end.bind(span);
          span.end = (time, exit) => {
            ended.push(JSON.stringify(exit));
            finish(time, exit);
          };
          return span;
        },
      });
      return Effect.scoped(
        Effect.gen(function* () {
          const secret = { token: "failure-secret", body: "body-secret", stack: "stack-secret" };
          const server = yield* makeServer(
            [
              service(Probe, {
                unary: () => Effect.fail(secret),
                watch: () =>
                  Stream.concat(
                    Stream.succeed(create(TextSchema, { value: "message-secret" })),
                    Stream.fail(secret),
                  ),
                upload: () => Effect.succeed(create(TextSchema)),
                chat: (s) => s,
              }),
            ],
            { address: "127.0.0.1:0", security: { mode: "insecure" } },
          );
          const client = yield* makeClient(Probe, {
            address: server.address,
            security: { mode: "insecure" },
          });
          yield* client.unary(create(TextSchema)).pipe(Effect.either);
          yield* client.watch(create(TextSchema)).pipe(Stream.runDrain, Effect.either);
        }),
      ).pipe(
        Effect.withTracer(tracer),
        Effect.provide(runtime),
        Effect.tap(() =>
          Effect.sync(() => {
            expect(ended.length).toBe(4);
            for (const value of ["failure-secret", "body-secret", "stack-secret", "message-secret"])
              expect(ended.join("\n")).not.toContain(value);
          }),
        ),
      );
    }),
  ));
