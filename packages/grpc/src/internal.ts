import type { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import type { Metadata as NativeMetadata } from "@grpc/grpc-js";
import { Correlation, Metrics } from "@structure-ai/observability";
import {
  Cause,
  Clock,
  Duration,
  Effect,
  Exit,
  Metric,
  MetricLabel,
  Option,
  type Scope,
  Stream,
} from "effect";
import type { FailureContract } from "./contract.js";
import { GrpcError, Status, statusMessage, toStatus } from "./errors.js";
import { type Metadata, safeId } from "./metadata.js";
export const FAILURE_KEY = "structure-failure-bin";
export const FAILURE_VERSION = "structure-failure-version";
export const MAX_FAILURE_BYTES = 8192;

export const remoteCode = (error: unknown): Status => {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return typeof code === "number" && Number.isInteger(code) && code >= 1 && code <= 16
    ? code
    : Status.INTERNAL;
};
export const decodeError = <E>(
  error: unknown,
  contract?: FailureContract<E>,
): Effect.Effect<never, GrpcError | E> => {
  const code = remoteCode(error);
  const metadata =
    typeof error === "object" && error !== null && "metadata" in error
      ? (error.metadata as NativeMetadata | undefined)
      : undefined;
  if (code === Status.FAILED_PRECONDITION && contract !== undefined && metadata !== undefined) {
    const version = metadata.get(FAILURE_VERSION)[0];
    const bytes = metadata.get(FAILURE_KEY)[0];
    if (version === "1" && bytes instanceof Uint8Array && bytes.byteLength <= MAX_FAILURE_BYTES)
      return contract.decode(bytes).pipe(Effect.flatMap(Effect.fail));
    return Effect.fail(new GrpcError({ code: Status.INTERNAL }));
  }
  return Effect.fail(new GrpcError({ code }));
};
/** Pull-mode reads preserve independent duplex halves and native bounded buffering. */
export const readRaw = (source: Readable): Stream.Stream<unknown, unknown> =>
  Stream.unwrapScoped(
    Effect.gen(function* () {
      let ended = source.readableEnded;
      let failed: unknown;
      const onEnd = () => {
        ended = true;
      };
      const onError = (error: unknown) => {
        failed = error;
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          source.on("end", onEnd);
          source.on("error", onError);
        }),
        () =>
          Effect.sync(() => {
            source.off("end", onEnd);
            source.off("error", onError);
          }),
      );
      return Stream.repeatEffectOption(
        Effect.async<unknown, Option.Option<unknown>>((resume) => {
          const cleanup = () => {
            source.off("readable", poll);
            source.off("end", poll);
            source.off("error", poll);
            source.off("close", poll);
          };
          const error = (e: unknown) => {
            cleanup();
            resume(Effect.fail(Option.some(e)));
          };
          const poll = () => {
            const value: unknown = source.read();
            if (value !== null) {
              cleanup();
              resume(Effect.succeed(value));
            } else if (failed !== undefined) {
              error(failed);
            } else if (ended || source.readableEnded) {
              cleanup();
              resume(Effect.fail(Option.none()));
            } else if (source.destroyed) {
              error(new GrpcError({ code: Status.CANCELLED }));
            }
          };
          source.on("readable", poll);
          source.on("end", poll);
          source.on("error", poll);
          source.on("close", poll);
          poll();
          return Effect.sync(cleanup);
        }),
      );
    }),
  );
export const read = (source: Readable): Stream.Stream<unknown, GrpcError> =>
  readRaw(source).pipe(
    Stream.mapError((e) => (e instanceof GrpcError ? e : new GrpcError({ code: remoteCode(e) }))),
  );
/** Wait for each transport write callback before pulling the next message. */
export const write = (
  target: Pick<Writable, "write" | "on" | "off">,
  value: unknown,
): Effect.Effect<void, GrpcError> =>
  Effect.async((resume) => {
    const error = () => {
      cleanup();
      resume(Effect.fail(new GrpcError({ code: Status.UNAVAILABLE })));
    };
    const cleanup = () => {
      target.off("error", error);
      target.off("close", error);
    };
    target.on("error", error);
    target.on("close", error);
    try {
      target.write(value, (err?: Error | null) => {
        cleanup();
        resume(err ? Effect.fail(new GrpcError({ code: Status.UNAVAILABLE })) : Effect.void);
      });
    } catch {
      error();
    }
    return Effect.sync(cleanup);
  });
export const correlationMetadata = (
  metadata: Metadata,
): Effect.Effect<{ metadata: NativeMetadata; id: string }> =>
  Effect.map(Correlation.current, (ambient) => {
    const id =
      safeId(ambient.correlationId) ??
      safeId(metadata.text("x-correlation-id")) ??
      Correlation.newId();
    const native = metadata.toNative();
    native.set("x-correlation-id", id);
    return { metadata: native, id };
  });
export const listen = (
  target: EventEmitter,
  event: string,
  handler: (...args: unknown[]) => void,
): Effect.Effect<void, never, import("effect").Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      target.on(event, handler);
    }),
    () =>
      Effect.sync(() => {
        target.off(event, handler);
      }),
  );
const boundaryStatus = (
  exit: Exit.Exit<unknown, unknown>,
  failure?: FailureContract<unknown>,
): Status => {
  let code = Exit.isSuccess(exit)
    ? Status.OK
    : Cause.isInterrupted(exit.cause)
      ? Status.CANCELLED
      : toStatus(Cause.isFailType(exit.cause) ? exit.cause.error : undefined);
  if (Exit.isFailure(exit) && Cause.isFailType(exit.cause) && failure !== undefined) {
    const error = exit.cause.error;
    try {
      const encoded = failure.encode(error);
      if (Option.isSome(encoded))
        code =
          encoded.value.byteLength <= MAX_FAILURE_BYTES
            ? Status.FAILED_PRECONDITION
            : Status.INTERNAL;
    } catch {
      code = Status.INTERNAL;
    }
  }
  return code;
};
/** Never hand raw application causes or successful message bodies to a tracer/exporter. */
export const boundarySpan = (
  side: "server" | "client",
  service: string,
  method: string,
  failure?: FailureContract<unknown>,
): Effect.Effect<import("effect").Tracer.Span, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.makeSpan(`grpc.${side}`, {
      kind: side,
      captureStackTrace: false,
      attributes: { "rpc.system": "grpc", "rpc.service": service, "rpc.method": method },
    }),
    (span, exit) =>
      Clock.currentTimeNanos.pipe(
        Effect.flatMap((time) =>
          Effect.sync(() => {
            const code = boundaryStatus(exit, failure);
            span.attribute("rpc.grpc.status_code", code);
            span.end(time, Exit.isSuccess(exit) ? Exit.void : Exit.fail(statusMessage(code)));
          }),
        ),
      ),
  );
export const recordBoundary = <E>(
  side: "server" | "client",
  service: string,
  method: string,
  started: number,
  exit: Exit.Exit<unknown, E>,
  failure?: FailureContract<unknown>,
): Effect.Effect<void> => {
  const metrics = Metrics.boundary(`grpc_${side}`);
  const code = boundaryStatus(exit, failure);
  const labels = { service, method, status: Status[code] ?? "UNKNOWN" };
  const tags = Object.entries(labels).map(([key, value]) => MetricLabel.make(key, value));
  return Effect.all(
    [
      Metric.update(Metric.taggedWithLabels(metrics.calls, tags), 1),
      Exit.isFailure(exit)
        ? Metric.update(Metric.taggedWithLabels(metrics.errors, tags), 1)
        : Effect.void,
      Metric.update(
        Metric.taggedWithLabels(metrics.duration, tags),
        Duration.millis(Date.now() - started),
      ),
      Effect.logDebug(`grpc ${side} completed`).pipe(Effect.annotateLogs(labels)),
    ],
    { discard: true },
  );
};
export const instrument = <A, E, R>(
  side: "server" | "client",
  service: string,
  method: string,
  effect: Effect.Effect<A, E, R>,
  failure?: FailureContract<unknown>,
): Effect.Effect<A, E, R> =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = Date.now();
      const span = yield* boundarySpan(side, service, method, failure);
      return yield* effect.pipe(
        Effect.onExit((exit) => recordBoundary(side, service, method, started, exit, failure)),
        Effect.withParentSpan(span),
      );
    }),
  );
