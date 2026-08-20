import * as HttpApiBuilder from "@effect/platform/HttpApiBuilder";
import * as HttpApp from "@effect/platform/HttpApp";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import { Correlation, Metrics } from "@structure-ai/observability";
import { Cause, Clock, Effect, type Layer, Option } from "effect";
import { defaultErrorResponse, HttpProblemSchema } from "./errors.js";

/**
 * Request correlation: reads `x-request-id` / `x-correlation-id` from the
 * incoming request (generating fresh uuids when absent), runs the request in
 * a `Correlation.within` scope — so every log line, span and CQRS dispatch
 * below carries the ids — and stamps both headers on the outgoing response
 * (whatever produced it) via a pre-response handler.
 */
export const correlation = <E, R>(
  app: HttpApp.Default<E, R>,
): HttpApp.Default<E, R | HttpServerRequest.HttpServerRequest> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const requestId = request.headers["x-request-id"] ?? Correlation.newId();
    const correlationId = request.headers["x-correlation-id"] ?? Correlation.newId();
    yield* HttpApp.appendPreResponseHandler((_request, response) =>
      Effect.succeed(
        HttpServerResponse.setHeaders(response, {
          "x-request-id": requestId,
          "x-correlation-id": correlationId,
        }),
      ),
    );
    return yield* Correlation.within({ requestId, correlationId })(app);
  });

/**
 * One structured log line per request at the boundary: method, path, status
 * and duration (ms) as log annotations — never bodies, never headers. The
 * line is emitted just before the response is sent, so the logged status is
 * the one on the wire.
 */
export const logger = <E, R>(
  app: HttpApp.Default<E, R>,
): HttpApp.Default<E, R | HttpServerRequest.HttpServerRequest> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const path = request.url.split("?")[0] ?? request.url;
    const started = yield* Clock.currentTimeMillis;
    const context = yield* Correlation.current;
    yield* HttpApp.appendPreResponseHandler((_request, response) =>
      Effect.flatMap(Clock.currentTimeMillis, (ended) =>
        Effect.logInfo("http request").pipe(
          Effect.annotateLogs({
            method: request.method,
            path,
            status: response.status,
            durationMs: ended - started,
            ...(context.correlationId !== undefined && { correlationId: context.correlationId }),
            ...(context.requestId !== undefined && { requestId: context.requestId }),
          }),
          Effect.as(response),
        ),
      ),
    );
    return yield* app;
  });

/**
 * Boundary metrics for the whole HTTP server under the single low-cardinality
 * name `http_server`: call counter, error counter and latency histogram (the
 * raw request path never becomes part of a metric name).
 */
export const metrics = <E, R>(app: HttpApp.Default<E, R>): HttpApp.Default<E, R> =>
  Metrics.track("http_server")(app);

/** Error tags this package knows how to render as problem responses. */
const knownTags: ReadonlySet<string> = new Set([
  "ValidationFailed",
  "Unauthenticated",
  "Unauthorized",
  "PermissionDenied",
  "NotFound",
  "ConcurrencyConflict",
  "DispatchTimeout",
  "InvariantViolation",
  "HandlerNotFound",
  "RouteNotFound",
  "HttpApiDecodeError",
]);

const isKnownError = (u: unknown): boolean =>
  HttpProblemSchema.members.some((member) => u instanceof member) ||
  (typeof u === "object" &&
    u !== null &&
    "_tag" in u &&
    typeof (u as { _tag: unknown })._tag === "string" &&
    knownTags.has((u as { _tag: string })._tag));

/**
 * Error boundary: renders the framework error taxonomy (and unknown routes)
 * as problem-details responses and turns defects into a 500 carrying only
 * the correlation id — the cause is logged server-side, never sent. Errors
 * it does not know (an app's custom endpoint error schemas) are re-failed so
 * the platform's schema-based encoding still applies to them.
 */
export const problems = <E, R>(app: HttpApp.Default<E, R>): HttpApp.Default<E, R> =>
  Effect.catchAllCause(app, (cause) =>
    Effect.gen(function* () {
      if (Cause.isInterruptedOnly(cause)) return yield* Effect.failCause(cause);
      const context = yield* Correlation.current;
      const failure = Cause.failureOption(cause);
      if (Option.isNone(failure)) {
        // A defect: log the full cause here, hide the details from the wire.
        yield* Effect.logError("http request defect", cause);
        return defaultErrorResponse(undefined, context.correlationId);
      }
      return isKnownError(failure.value)
        ? defaultErrorResponse(failure.value, context.correlationId)
        : yield* Effect.failCause(cause);
    }),
  );

/**
 * The standard middleware stack, outermost first: correlation → logging →
 * metrics → problem mapping.
 */
export const standard = <E, R>(
  app: HttpApp.Default<E, R>,
): HttpApp.Default<E, R | HttpServerRequest.HttpServerRequest> =>
  correlation(logger(metrics(problems(app))));

/**
 * The standard stack as an `HttpApi`-level middleware layer. Provide it next
 * to your api implementation (`serve`/`serveTest` already do):
 *
 * ```ts
 * HttpApiBuilder.serve().pipe(Layer.provide(Middleware.layer), ...)
 * ```
 */
export const layer: Layer.Layer<never> = HttpApiBuilder.middleware(standard);
