import type { EventEmitter } from "node:events";
import type { DescService } from "@bufbuild/protobuf";
import * as Native from "@grpc/grpc-js";
import { Correlation } from "@structure-ai/observability";
import { Deferred, Effect, type Scope, Stream, Tracer } from "effect";
import {
  type FailureContract,
  type FailureContracts,
  type Input,
  methodDefinition,
  type Output,
} from "./contract.js";
import { GrpcConfigError, GrpcError, Status } from "./errors.js";
import {
  boundarySpan,
  correlationMetadata,
  decodeError,
  instrument,
  listen,
  readRaw,
  recordBoundary,
  write,
} from "./internal.js";
import { Metadata } from "./metadata.js";
import { clientCredentials, limits, type TransportOptions, validate } from "./options.js";
export interface CallOptions {
  readonly metadata?: Metadata;
  readonly timeoutMs?: number;
  readonly onHeaders?: (metadata: Metadata) => void;
  readonly onTrailers?: (metadata: Metadata) => void;
}
export interface ClientOptions<S extends DescService, F extends FailureContracts<S>>
  extends TransportOptions {
  readonly timeoutMs?: number;
  readonly failures?: F;
}
type Failure<F, K extends PropertyKey> = K extends keyof F
  ? F[K] extends FailureContract<infer E>
    ? E
    : never
  : never;
export type Client<S extends DescService, F = Record<never, never>> = {
  readonly [K in keyof S["method"]]: S["method"][K]["methodKind"] extends "unary"
    ? (
        request: Input<S["method"][K]>,
        options?: CallOptions,
      ) => Effect.Effect<Output<S["method"][K]>, GrpcError | Failure<F, K>>
    : S["method"][K]["methodKind"] extends "server_streaming"
      ? (
          request: Input<S["method"][K]>,
          options?: CallOptions,
        ) => Stream.Stream<Output<S["method"][K]>, GrpcError | Failure<F, K>>
      : S["method"][K]["methodKind"] extends "client_streaming"
        ? <E, R>(
            request: Stream.Stream<Input<S["method"][K]>, E, R>,
            options?: CallOptions,
          ) => Effect.Effect<Output<S["method"][K]>, GrpcError | Failure<F, K> | E, R>
        : <E, R>(
            request: Stream.Stream<Input<S["method"][K]>, E, R>,
            options?: CallOptions,
          ) => Stream.Stream<Output<S["method"][K]>, GrpcError | Failure<F, K> | E, R>;
};
/** Scope owns the channel. Each call/stream owns cancellation and listeners. No automatic retries. */
export const makeClient = <
  S extends DescService,
  F extends FailureContracts<S> = Record<never, never>,
>(
  descriptor: S,
  options: ClientOptions<NoInfer<S>, F>,
): Effect.Effect<Client<S, F>, GrpcConfigError | GrpcError, Scope.Scope> =>
  Effect.gen(function* () {
    yield* validate(options, false);
    const timeoutMs = options.timeoutMs ?? 30000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 86400000)
      return yield* Effect.fail(
        new GrpcConfigError({ violations: ["timeoutMs must be between 1 and 86400000"] }),
      );
    const bounded = limits(options);
    let open = true;
    const native = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          new Native.Client(options.address, clientCredentials(options.security), {
            ...(options.security.mode === "tls" && options.security.serverName !== undefined
              ? {
                  "grpc.ssl_target_name_override": options.security.serverName,
                  "grpc.default_authority": options.security.serverName,
                }
              : {}),
            "grpc.enable_retries": 0,
            "grpc.enable_http_proxy": 0,
            "grpc.service_config_disable_resolution": 1,
            "grpc.max_send_message_length": bounded.send,
            "grpc-node.max_session_memory": 8,
            "grpc.max_receive_message_length": bounded.receive,
            "grpc.use_local_subchannel_pool": 1,
            "grpc.enable_channelz": 0,
          }),
        catch: () => new GrpcError({ code: Status.UNAVAILABLE }),
      }),
      (client) =>
        Effect.sync(() => {
          open = false;
          client.close();
        }),
    );
    const result: Record<string, unknown> = {};
    for (const method of descriptor.methods) {
      const definition = methodDefinition(descriptor, method);
      const failure = options.failures?.[method.localName];
      const setup = (callOptions?: CallOptions) =>
        Effect.gen(function* () {
          if (!open) return yield* Effect.fail(new GrpcError({ code: Status.UNAVAILABLE }));
          const timeout = callOptions?.timeoutMs ?? timeoutMs;
          if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 86400000)
            return yield* Effect.fail(new GrpcError({ code: Status.INVALID_ARGUMENT }));
          const correlation = yield* correlationMetadata(callOptions?.metadata ?? new Metadata());
          return { ...correlation, call: { deadline: Date.now() + timeout } };
        });
      const events = (
        call:
          | Native.ClientUnaryCall
          | Native.ClientReadableStream<unknown>
          | Native.ClientWritableStream<unknown>,
        callOptions?: CallOptions,
      ) =>
        Effect.gen(function* () {
          yield* listen(call, "metadata", (value) => {
            callOptions?.onHeaders?.(Metadata.fromNative(value as Native.Metadata));
          });
          yield* listen(call, "status", (value) => {
            callOptions?.onTrailers?.(Metadata.fromNative((value as Native.StatusObject).metadata));
          });
          const swallow = () => {};
          (call as EventEmitter).on("error", swallow);
          (call as EventEmitter).once("status", () => (call as EventEmitter).off("error", swallow));
        });
      const unary = (input: unknown, callOptions?: CallOptions) =>
        Effect.scoped(
          Effect.gen(function* () {
            const config = yield* setup(callOptions);
            const response = yield* Deferred.make<unknown, unknown>();
            const call = yield* Effect.acquireRelease(
              Effect.sync(() =>
                native.makeUnaryRequest(
                  definition.path,
                  definition.requestSerialize,
                  definition.responseDeserialize,
                  input,
                  config.metadata,
                  config.call,
                  (error, value) => {
                    Effect.runSync(
                      error ? Deferred.fail(response, error) : Deferred.succeed(response, value),
                    );
                  },
                ),
              ),
              (call) =>
                Effect.sync(() => {
                  call.cancel();
                }),
            );
            yield* events(call, callOptions);
            return yield* Deferred.await(response).pipe(
              Effect.catchAll((error) => decodeError(error, failure)),
              Correlation.within({ correlationId: config.id }),
              (e) => instrument("client", descriptor.typeName, method.name, e, failure),
            );
          }),
        );
      const upload = <E, R>(input: Stream.Stream<unknown, E, R>, callOptions?: CallOptions) =>
        Effect.scoped(
          Effect.gen(function* () {
            const config = yield* setup(callOptions);
            const response = yield* Deferred.make<unknown, unknown>();
            const call = yield* Effect.acquireRelease(
              Effect.sync(() =>
                native.makeClientStreamRequest(
                  definition.path,
                  definition.requestSerialize,
                  definition.responseDeserialize,
                  config.metadata,
                  config.call,
                  (error, value) => {
                    Effect.runSync(
                      error ? Deferred.fail(response, error) : Deferred.succeed(response, value),
                    );
                  },
                ),
              ),
              (call) =>
                Effect.sync(() => {
                  call.cancel();
                }),
            );
            yield* events(call, callOptions);
            const send = Stream.runForEach(input, (value) => write(call, value)).pipe(
              Effect.andThen(Effect.sync(() => call.end())),
              Effect.andThen(Effect.never),
            );
            return yield* Effect.raceFirst(
              Deferred.await(response).pipe(
                Effect.catchAll((error) => decodeError(error, failure)),
              ),
              send,
            ).pipe(Correlation.within({ correlationId: config.id }), (e) =>
              instrument("client", descriptor.typeName, method.name, e, failure),
            );
          }),
        );
      const streaming = <E, R>(
        input: unknown | Stream.Stream<unknown, E, R>,
        callOptions?: CallOptions,
      ): Stream.Stream<unknown, unknown, R> =>
        Stream.unwrapScoped(
          Effect.gen(function* () {
            const config = yield* setup(callOptions);
            const started = Date.now();
            const bidi = method.methodKind === "bidi_streaming";
            const call = yield* Effect.acquireRelease(
              Effect.sync(() =>
                bidi
                  ? native.makeBidiStreamRequest(
                      definition.path,
                      definition.requestSerialize,
                      definition.responseDeserialize,
                      config.metadata,
                      config.call,
                    )
                  : native.makeServerStreamRequest(
                      definition.path,
                      definition.requestSerialize,
                      definition.responseDeserialize,
                      input,
                      config.metadata,
                      config.call,
                    ),
              ),
              (call) =>
                Effect.sync(() => {
                  call.cancel();
                }),
            );
            yield* events(call, callOptions);
            const span = yield* boundarySpan("client", descriptor.typeName, method.name, failure);
            const incoming = readRaw(call).pipe(
              Stream.catchAll((error) => Stream.fromEffect(decodeError(error, failure))),
            );
            const output = bidi
              ? Stream.merge(
                  incoming,
                  Stream.drain(
                    Stream.fromEffect(
                      Stream.runForEach(input as Stream.Stream<unknown, E, R>, (value) =>
                        write(call as Native.ClientDuplexStream<unknown, unknown>, value),
                      ).pipe(
                        Effect.andThen(
                          Effect.sync(() =>
                            (call as Native.ClientDuplexStream<unknown, unknown>).end(),
                          ),
                        ),
                      ),
                    ),
                  ),
                  { haltStrategy: "left" },
                )
              : incoming;
            return output.pipe(
              Stream.buffer({ capacity: bounded.buffer }),

              Stream.ensuringWith((exit) =>
                recordBoundary(
                  "client",
                  descriptor.typeName,
                  method.name,
                  started,
                  exit,
                  failure,
                ).pipe(Correlation.within({ correlationId: config.id })),
              ),
              Stream.provideService(Tracer.ParentSpan, span),
            );
          }),
        );
      result[method.localName] =
        method.methodKind === "unary"
          ? unary
          : method.methodKind === "client_streaming"
            ? upload
            : streaming;
    }
    return result as Client<S, F>;
  });
