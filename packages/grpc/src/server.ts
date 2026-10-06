import type { EventEmitter } from "node:events";
import type { Readable } from "node:stream";
import * as Native from "@grpc/grpc-js";
import { Correlation } from "@structure-ai/observability";
import { Readiness, Shutdown } from "@structure-ai/runtime";
import { Cause, Effect, Fiber, Option, Runtime, type Scope, Stream } from "effect";
import {
  invalidRequest,
  methodDefinition,
  type RequestContext,
  type ServiceRegistration,
} from "./contract.js";
import { GrpcConfigError, GrpcError, Status, statusMessage, toStatus } from "./errors.js";
import {
  FAILURE_KEY,
  FAILURE_VERSION,
  instrument,
  MAX_FAILURE_BYTES,
  read,
  write,
} from "./internal.js";
import { Metadata, safeId } from "./metadata.js";
import { limits, serverCredentials, type TransportOptions, validate } from "./options.js";

/** Verification and policy context belong to the application. The returned actor is trusted. */
export interface VerifiedContext {
  readonly actor?: string;
  readonly within?: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}
export interface ServerOptions<R = never> extends TransportOptions {
  readonly graceMs?: number;
  readonly maxActiveCalls?: number;
  readonly maxCallMs?: number;
  readonly verify?: (
    request: Omit<RequestContext, "sendHeaders" | "setTrailers" | "actor">,
  ) => Effect.Effect<VerifiedContext, unknown, R>;
}
export interface Server {
  readonly address: string;
  readonly isAccepting: Effect.Effect<boolean>;
  readonly activeCalls: Effect.Effect<number>;
  /** Idempotent, also registered with Shutdown and scope finalization. */
  readonly close: Effect.Effect<void>;
}
type Call =
  | Native.ServerUnaryCall<unknown, unknown>
  | Native.ServerReadableStream<unknown, unknown>
  | Native.ServerWritableStream<unknown, unknown>
  | Native.ServerDuplexStream<unknown, unknown>;

/** Acquire a native HTTP/2 gRPC listener in a scope. Captures handler services at acquisition. */
export const makeServer = <R = never, RVerify = never>(
  registrations: ReadonlyArray<ServiceRegistration<R>>,
  options: ServerOptions<RVerify>,
): Effect.Effect<
  Server,
  GrpcConfigError | GrpcError,
  R | RVerify | Readiness | Shutdown | Scope.Scope
> =>
  Effect.gen(function* () {
    yield* validate(options, true, options.graceMs ?? 1000);
    if ((yield* Correlation.current).actor !== undefined)
      return yield* Effect.fail(
        new GrpcConfigError({
          violations: ["Acquire the server outside an actor scope; verify identity per request"],
        }),
      );
    const capacity = options.maxActiveCalls ?? 1024;
    const maxCallMs = options.maxCallMs ?? 30000;
    if (!Number.isSafeInteger(maxCallMs) || maxCallMs < 1 || maxCallMs > 86400000)
      return yield* Effect.fail(
        new GrpcConfigError({ violations: ["maxCallMs must be between 1 and 86400000"] }),
      );
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 65536)
      return yield* Effect.fail(
        new GrpcConfigError({ violations: ["maxActiveCalls must be between 1 and 65536"] }),
      );
    const runtime = yield* Effect.runtime<R | RVerify>();
    const readiness = yield* Readiness;
    const shutdown = yield* Shutdown;
    const bounded = limits(options);
    const native = yield* Effect.try({
      try: () =>
        new Native.Server({
          "grpc.max_receive_message_length": bounded.receive,
          "grpc.max_send_message_length": bounded.send,
          "grpc-node.max_session_memory": 8,
          "grpc.max_concurrent_streams": capacity,
        }),
      catch: () => new GrpcError({ code: Status.INTERNAL }),
    });
    const active = new Set<Fiber.RuntimeFiber<void, never>>();
    let accepting = true;
    let closed: Promise<void> | undefined;
    const close = Effect.suspend(() =>
      Effect.promise(() => {
        if (closed !== undefined) return closed;
        accepting = false;
        closed = new Promise<void>((resolve) => {
          const force = () => {
            native.forceShutdown();
            Runtime.runPromise(runtime)(
              Effect.forEach([...active], Fiber.interrupt, { discard: true }),
            ).then(() => resolve());
          };
          const timer = setTimeout(force, options.graceMs ?? 1000);
          native.tryShutdown(() => {
            clearTimeout(timer);
            Runtime.runPromise(runtime)(
              Effect.forEach([...active], Fiber.await, { discard: true }),
            ).then(() => resolve());
          });
        });
        return closed;
      }),
    ).pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          accepting = false;
          native.forceShutdown();
          for (const fiber of active) Runtime.runFork(runtime)(Fiber.interrupt(fiber));
        }),
      ),
    );
    // Register before bind so cancellation or an invalid service releases the listener as well.
    yield* Effect.addFinalizer(() => readiness.setUnready.pipe(Effect.andThen(close)));

    for (const registration of registrations) {
      const definition: Record<string, Native.MethodDefinition<unknown, unknown>> = {};
      const implementation: Native.UntypedServiceImplementation = {};
      for (const method of registration.descriptor.methods) {
        const handler = registration.handlers[method.localName];
        if (handler === undefined)
          return yield* Effect.fail(
            new GrpcConfigError({ violations: [`Missing handler for ${method.name}`] }),
          );
        definition[method.localName] = methodDefinition(registration.descriptor, method);
        const invoke = (call: Call, callback?: Native.sendUnaryData<unknown>) => {
          const atCapacity = active.size >= capacity;
          let trailers = new Native.Metadata();
          let headersSent = false;
          const correlationId =
            safeId(Metadata.fromNative(call.metadata).text("x-correlation-id")) ??
            Correlation.newId();
          const deadlineRaw = call.getDeadline();
          const deadline = Math.min(
            deadlineRaw instanceof Date ? deadlineRaw.getTime() : deadlineRaw,
            Date.now() + maxCallMs,
          );
          const initial = new Native.Metadata();
          initial.set("x-correlation-id", correlationId);
          const sendHeaders = (metadata: Metadata) =>
            Effect.try({
              try: () => {
                if (headersSent) throw new Error("Headers already sent");
                const out = metadata.toNative();
                out.set("x-correlation-id", correlationId);
                call.sendMetadata(out);
                headersSent = true;
              },
              catch: () => new GrpcError({ code: Status.INTERNAL }),
            });
          const sendDefault = () => {
            if (!headersSent) {
              call.sendMetadata(initial);
              headersSent = true;
            }
          };
          const base = {
            service: registration.descriptor.typeName,
            method: method.name,
            metadata: Metadata.fromNative(call.metadata),
            correlationId,
            deadline,
            remainingMs: Effect.sync(() => Math.max(0, deadline - Date.now())),
          };
          const operation = Effect.gen(function* () {
            if (!accepting) return yield* Effect.fail(new GrpcError({ code: Status.UNAVAILABLE }));
            if (atCapacity)
              return yield* Effect.fail(new GrpcError({ code: Status.RESOURCE_EXHAUSTED }));
            const verified = options.verify === undefined ? {} : yield* options.verify(base);
            const context: RequestContext = {
              ...base,
              actor: verified.actor,
              sendHeaders,
              setTrailers: (metadata) =>
                Effect.sync(() => {
                  trailers = metadata.toNative();
                }),
            };
            const checked = (value: unknown) =>
              value === invalidRequest
                ? Effect.fail(new GrpcError({ code: Status.INVALID_ARGUMENT }))
                : Effect.succeed(value);
            const input =
              "request" in call
                ? yield* checked(call.request)
                : read(call as Readable).pipe(Stream.mapEffect(checked));
            const result = handler(input, context);
            const apply = verified.within ?? ((effect) => effect);
            const work =
              method.methodKind === "server_streaming" || method.methodKind === "bidi_streaming"
                ? Stream.runForEach(result as Stream.Stream<unknown, unknown, R>, (value) =>
                    Effect.sync(sendDefault).pipe(
                      Effect.andThen(
                        write(call as Native.ServerWritableStream<unknown, unknown>, value),
                      ),
                    ),
                  )
                : (result as Effect.Effect<unknown, unknown, R>).pipe(
                    Effect.flatMap((value) =>
                      Effect.sync(() => {
                        sendDefault();
                        callback?.(null, value, trailers);
                      }),
                    ),
                  );
            yield* apply(work).pipe(
              Correlation.within({
                correlationId,
                ...(verified.actor === undefined ? {} : { actor: verified.actor }),
              }),
            );
            if (method.methodKind === "server_streaming" || method.methodKind === "bidi_streaming")
              yield* Effect.sync(() => {
                sendDefault();
                (call as Native.ServerWritableStream<unknown, unknown>).end(trailers);
              });
          }).pipe(
            Effect.timeoutFail({
              duration: Math.max(0, deadline - Date.now()),
              onTimeout: () => new GrpcError({ code: Status.DEADLINE_EXCEEDED }),
            }),
            Correlation.within({ correlationId }),
            (e) =>
              instrument(
                "server",
                registration.descriptor.typeName,
                method.name,
                e,
                registration.failures[method.localName],
              ),
            Effect.catchAllCause((cause) =>
              Effect.sync(() => {
                let code = Cause.isInterrupted(cause)
                  ? Status.CANCELLED
                  : toStatus(Cause.isFailType(cause) ? cause.error : undefined);
                const business = Cause.isFailType(cause)
                  ? registration.failures[method.localName]?.encode(cause.error)
                  : undefined;
                if (business !== undefined && Option.isSome(business)) {
                  if (business.value.byteLength <= MAX_FAILURE_BYTES) {
                    code = Status.FAILED_PRECONDITION;
                    trailers.set(FAILURE_VERSION, "1");
                    trailers.set(FAILURE_KEY, Buffer.from(business.value));
                  } else code = Status.INTERNAL;
                }
                const error = { code, details: statusMessage(code), metadata: trailers };
                if (!call.cancelled) {
                  sendDefault();
                  if (callback !== undefined) callback(error, null, trailers);
                  else call.emit("error", error);
                }
              }),
            ),
          );
          const fiber = Runtime.runFork(runtime)(Effect.scoped(operation));
          const cancel = () => {
            Runtime.runFork(runtime)(Fiber.interrupt(fiber));
          };
          (call as EventEmitter).on("cancelled", cancel);
          active.add(fiber);
          fiber.addObserver(() => {
            active.delete(fiber);
            (call as EventEmitter).off("cancelled", cancel);
          });
          if (call.cancelled) cancel();
        };
        implementation[method.localName] = invoke;
      }
      yield* Effect.try({
        try: () => native.addService(definition, implementation),
        catch: () =>
          new GrpcConfigError({ violations: ["Invalid or duplicate service registration"] }),
      });
    }
    const port = yield* Effect.async<number, GrpcError>((resume) => {
      try {
        native.bindAsync(options.address, serverCredentials(options.security), (error, port) =>
          resume(
            error ? Effect.fail(new GrpcError({ code: Status.UNAVAILABLE })) : Effect.succeed(port),
          ),
        );
      } catch {
        resume(Effect.fail(new GrpcError({ code: Status.UNAVAILABLE })));
      }
      return Effect.sync(() => native.forceShutdown());
    });
    const address = options.address.replace(/:\d+$/, `:${port}`);
    yield* readiness.register({ name: `grpc:${address}`, run: Effect.sync(() => accepting) });
    yield* shutdown.onShutdown(`grpc:${address}`, close);
    return {
      address,
      close,
      isAccepting: Effect.sync(() => accepting),
      activeCalls: Effect.sync(() => active.size),
    };
  });
