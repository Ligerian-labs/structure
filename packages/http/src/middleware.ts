import * as HttpApi from "@effect/platform/HttpApi";
import * as HttpApiBuilder from "@effect/platform/HttpApiBuilder";
import type * as HttpApiGroup from "@effect/platform/HttpApiGroup";
import * as HttpApp from "@effect/platform/HttpApp";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import { Correlation, Metrics } from "@structure-ai/observability";
import {
  Cause,
  Clock,
  Effect,
  FiberRef,
  type Layer,
  Metric,
  MetricBoundaries,
  MetricLabel,
} from "effect";
import { globalValue } from "effect/GlobalValue";
import { DeclaredBusinessFailure } from "./cqrs.js";
import { defaultErrorResponse, isKnownError } from "./errors.js";

// --- propagated ids ----------------------------------------------------------

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Whether a propagated id may be reused: 1–64 characters of
 * `[A-Za-z0-9_-]`. Anything else (whitespace, control bytes, blobs) is
 * treated as absent, so a client can never write arbitrary bytes into the log
 * stream, span attributes, or response headers through `x-request-id` /
 * `x-correlation-id`.
 */
export const isSafeId = (value: string): boolean => SAFE_ID.test(value);

/** Options for {@link correlation}. */
export interface CorrelationOptions {
  /**
   * What to do with an incoming `x-request-id` / `x-correlation-id` header:
   *
   * - `"sanitize"` (default) — keep the id when {@link isSafeId} accepts it,
   *   mint a fresh one otherwise (today's behavior);
   * - `"reject"` — never trust incoming ids, always mint fresh ones;
   * - a predicate — keep the id only when the predicate returns `true`.
   *   Header-safety still applies: an id that fails {@link isSafeId} is never
   *   echoed back, whatever the predicate says.
   */
  readonly incoming?: "sanitize" | "reject" | ((id: string) => boolean);
  /** Mint ids with this instead of a fresh uuid (`Correlation.newId`). */
  readonly generate?: () => string;
  /**
   * Which headers the outgoing response carries: a name overrides the
   * standard one, `null` suppresses that header. Default
   * `{ request: "x-request-id", correlation: "x-correlation-id" }`. Incoming
   * ids are always read from the standard names.
   */
  readonly headers?: {
    readonly request?: string | null;
    readonly correlation?: string | null;
  };
}

/** RFC 7230 token — the only shape safe to use as a response header name. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Validates {@link CorrelationOptions} and lists every violation (malformed
 * header names, duplicate names, unknown policies). Composition bugs surface
 * at startup, not on the first response.
 */
export const correlationViolations = (
  options: CorrelationOptions | undefined,
): ReadonlyArray<string> => {
  if (options === undefined) return [];
  const violations: Array<string> = [];
  const { incoming, generate, headers } = options;
  if (
    incoming !== undefined &&
    incoming !== "sanitize" &&
    incoming !== "reject" &&
    typeof incoming !== "function"
  ) {
    violations.push(`correlation.incoming must be "sanitize", "reject" or a predicate`);
  }
  if (generate !== undefined && typeof generate !== "function") {
    violations.push("correlation.generate must be a function");
  }
  if (headers !== undefined) {
    for (const [slot, name] of [
      ["request", headers.request],
      ["correlation", headers.correlation],
    ] as const) {
      if (name === undefined || name === null) continue;
      if (typeof name !== "string" || !HEADER_NAME.test(name)) {
        violations.push(
          `correlation.headers.${slot} (${JSON.stringify(name)}) is not a valid header name`,
        );
      }
    }
    if (typeof headers.request === "string" && headers.request === headers.correlation) {
      violations.push(
        `correlation.headers.request and .correlation must differ ("${headers.request}" used twice)`,
      );
    }
  }
  return violations;
};

interface ResolvedCorrelation {
  readonly resolveId: (value: string | undefined) => string;
  /** `[headerName, idKey]` pairs to stamp on the response, in order. */
  readonly emit: ReadonlyArray<readonly [name: string, key: "requestId" | "correlationId"]>;
}

const resolveCorrelation = (options: CorrelationOptions | undefined): ResolvedCorrelation => {
  const generate = options?.generate ?? Correlation.newId;
  const incoming = options?.incoming;
  const resolveId = (value: string | undefined): string => {
    if (value === undefined) return generate();
    if (typeof incoming === "function")
      return isSafeId(value) && incoming(value) ? value : generate();
    if (incoming === "reject") return generate();
    return isSafeId(value) ? value : generate();
  };
  const request =
    options?.headers?.request === undefined ? "x-request-id" : options.headers.request;
  const correlation =
    options?.headers?.correlation === undefined ? "x-correlation-id" : options.headers.correlation;
  const emit: Array<readonly [string, "requestId" | "correlationId"]> = [];
  if (request !== null) emit.push([request, "requestId"]);
  if (correlation !== null) emit.push([correlation, "correlationId"]);
  return { resolveId, emit };
};

/**
 * Request correlation: reads `x-request-id` / `x-correlation-id` from the
 * incoming request — keeping them only when {@link isSafeId}, minting fresh
 * uuids otherwise — runs the request in a `Correlation.within` scope so every
 * log line, span and CQRS dispatch below carries the ids, and stamps both
 * (sanitized) headers on the outgoing response, whatever produced it, via a
 * pre-response handler.
 *
 * `options` customizes the incoming-id policy, the generator and the emitted
 * header names; {@link correlationViolations} lists what makes them invalid.
 */
export const correlation = <E, R>(
  app: HttpApp.Default<E, R>,
  options?: CorrelationOptions,
): HttpApp.Default<E, R | HttpServerRequest.HttpServerRequest> => {
  const { resolveId, emit } = resolveCorrelation(options);
  const stamp = (requestId: string, correlationId: string): Record<string, string> => {
    const headers: Record<string, string> = {};
    for (const [name, key] of emit) headers[name] = key === "requestId" ? requestId : correlationId;
    return headers;
  };
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const requestId = resolveId(request.headers["x-request-id"]);
    const correlationId = resolveId(request.headers["x-correlation-id"]);
    yield* HttpApp.appendPreResponseHandler((_request, response) =>
      Effect.succeed(HttpServerResponse.setHeaders(response, stamp(requestId, correlationId))),
    );
    return yield* Correlation.within({ requestId, correlationId })(app);
  });
};

// --- route labels ------------------------------------------------------------

/** Route label for requests that matched no known endpoint template. */
export const UNMATCHED_ROUTE = "(unmatched)";

/**
 * Resolves the bounded label telemetry uses for a request: the matched
 * endpoint template (`/things/:id`), or {@link UNMATCHED_ROUTE}. `path` is the
 * request path without its query string.
 */
export type RouteLabel = (method: string, path: string) => string;

/** Options for {@link routeLabel}. */
export interface RouteLabelOptions {
  /**
   * Templates for routes mounted next to the api rather than declared on it
   * (docs, static mounts…), matched for any method. Same syntax as endpoint
   * paths: `:name` segments are parameters, `*` matches the rest.
   */
  readonly extra?: ReadonlyArray<`/${string}`>;
}

interface RoutePattern {
  readonly method: string | undefined;
  readonly template: string;
  readonly matcher: RegExp;
}

const escapeLiteral = (segment: string): string => segment.replace(/[^A-Za-z0-9_]/g, "\\$&");

/**
 * Compiles a router template into an anchored matcher: `:name` (optionally
 * constrained, `:id(\\d+)`) matches one non-empty segment, `*` matches the
 * rest of the path, everything else is literal.
 */
const compileTemplate = (template: string): RegExp => {
  const source = template
    .split("/")
    .map((segment) =>
      segment === "*"
        ? ".*"
        : segment.replace(/:[A-Za-z0-9_]+(?:\([^)]*\))?|[^:]+|:/g, (token) =>
            token.startsWith(":") && token.length > 1 ? "[^/]+" : escapeLiteral(token),
          ),
    )
    .join("/");
  return new RegExp(`^${source}$`);
};

const matchRoute = (patterns: ReadonlyArray<RoutePattern>): RouteLabel => {
  const byMethod = new Map<string | undefined, Array<RoutePattern>>();
  for (const pattern of patterns) {
    const bucket = byMethod.get(pattern.method) ?? [];
    bucket.push(pattern);
    byMethod.set(pattern.method, bucket);
  }
  return (method, path) => {
    const candidates = [...(byMethod.get(method) ?? []), ...(byMethod.get(undefined) ?? [])];
    for (const candidate of candidates) {
      if (candidate.matcher.test(path)) return candidate.template;
    }
    return UNMATCHED_ROUTE;
  };
};

/**
 * Builds a {@link RouteLabel} from an api's declared endpoints (via
 * `HttpApi.reflect`, so group and api prefixes are included). The label is the
 * endpoint's path template — never the requested path — which keeps
 * capabilities carried in path segments (share secrets, invitation tokens)
 * out of logs and metric labels, and keeps metric cardinality bounded.
 *
 * ```ts
 * const resolve = Middleware.routeLabel(api, { extra: ["/docs", "/openapi.json"] });
 * resolve("GET", "/things/secret-token"); // "/things/:id"
 * resolve("GET", "/wp-admin");            // "(unmatched)"
 * ```
 */
export const routeLabel = <Id extends string, Groups extends HttpApiGroup.HttpApiGroup.Any, E, R>(
  api: HttpApi.HttpApi<Id, Groups, E, R>,
  options?: RouteLabelOptions,
): RouteLabel => {
  const patterns: Array<RoutePattern> = [];
  HttpApi.reflect(api, {
    onGroup: () => {},
    onEndpoint: ({ endpoint }) => {
      patterns.push({
        method: endpoint.method,
        template: endpoint.path,
        matcher: compileTemplate(endpoint.path),
      });
    },
  });
  for (const template of options?.extra ?? []) {
    patterns.push({ method: undefined, template, matcher: compileTemplate(template) });
  }
  return matchRoute(patterns);
};

/** The route label of the request being served; `(unmatched)` outside {@link withRouteLabel}. */
export const currentRouteLabel: FiberRef.FiberRef<string> = globalValue(
  "@structure-ai/http/Middleware/currentRouteLabel",
  () => FiberRef.unsafeMake<string>(UNMATCHED_ROUTE),
);

/**
 * Resolves the request's route label once and makes it the
 * {@link currentRouteLabel} for everything below — the boundary logger and
 * metrics read it there. Outermost layer of the standard stack.
 */
export const withRouteLabel =
  (resolve: RouteLabel) =>
  <E, R>(app: HttpApp.Default<E, R>): HttpApp.Default<E, R | HttpServerRequest.HttpServerRequest> =>
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
      Effect.locally(
        app,
        currentRouteLabel,
        resolve(request.method, request.url.split("?")[0] ?? request.url),
      ),
    );

// --- boundary logging and metrics -------------------------------------------

/**
 * One structured log line per request at the boundary, as log annotations:
 * `method`, `route` (the matched template or `(unmatched)`), `status`,
 * `durationMs`, and the correlation ids — never the raw path, never bodies,
 * never headers. The line is emitted just before the response is sent, so
 * the logged status is the one on the wire.
 */
export const logger = <E, R>(
  app: HttpApp.Default<E, R>,
): HttpApp.Default<E, R | HttpServerRequest.HttpServerRequest> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const route = yield* FiberRef.get(currentRouteLabel);
    const started = yield* Clock.currentTimeMillis;
    const context = yield* Correlation.current;
    yield* HttpApp.appendPreResponseHandler((_request, response) =>
      Effect.flatMap(Clock.currentTimeMillis, (ended) =>
        Effect.logInfo("http request").pipe(
          Effect.annotateLogs({
            method: request.method,
            route,
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

const REQUEST_DURATION_BOUNDARIES_SECONDS: ReadonlyArray<number> = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

/**
 * Per-route latency histogram, in seconds, tagged `method`, `route` and
 * `status` — the labels dashboards slice by. Cardinality is bounded by the
 * api's endpoint templates.
 */
export const requestDuration = Metric.histogram(
  "http_request_duration_seconds",
  MetricBoundaries.fromIterable(REQUEST_DURATION_BOUNDARIES_SECONDS),
  "HTTP request latency by route template",
);

const serverBoundary = Metrics.boundary("http_server");

const tagBoundary = (labels: ReadonlyArray<MetricLabel.MetricLabel>): Metrics.BoundaryMetrics => ({
  calls: Metric.taggedWithLabels(serverBoundary.calls, labels),
  errors: Metric.taggedWithLabels(serverBoundary.errors, labels),
  duration: Metric.taggedWithLabels(serverBoundary.duration, labels),
});

/**
 * Boundary metrics for the whole HTTP server: the `http_server` call, error
 * and latency signals tagged `method` and `route`, plus
 * {@link requestDuration} (`http_request_duration_seconds{method,route,status}`)
 * observed once the status is known. Only these metrics are tagged — nothing
 * nested (bus dispatch, rate limiting) inherits the labels. The raw request
 * path never becomes a metric name or label.
 */
export const metrics = <E, R>(
  app: HttpApp.Default<E, R>,
): HttpApp.Default<E, R | HttpServerRequest.HttpServerRequest> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const route = yield* FiberRef.get(currentRouteLabel);
    const labels = [MetricLabel.make("method", request.method), MetricLabel.make("route", route)];
    const started = yield* Clock.currentTimeMillis;
    yield* HttpApp.appendPreResponseHandler((_request, response) =>
      Effect.flatMap(Clock.currentTimeMillis, (ended) =>
        Metric.update(
          Metric.taggedWithLabels(requestDuration, [
            ...labels,
            MetricLabel.make("status", String(response.status)),
          ]),
          (ended - started) / 1000,
        ).pipe(Effect.as(response)),
      ),
    );
    return yield* Metrics.track(
      "http_server",
      tagBoundary(labels),
    )(app).pipe(Effect.annotateSpans({ "http.method": request.method, "http.route": route }));
  });

/**
 * Error boundary: renders the framework error taxonomy (and unknown routes)
 * as problem-details responses and turns defects into a 500 carrying only
 * the correlation id — the cause is logged server-side, never sent. Errors
 * it does not know (an app's custom endpoint error schemas, and the bridge's
 * declared business failures) are re-failed so the platform's schema-based
 * encoding still applies to them.
 */
export const problems = <E, R>(app: HttpApp.Default<E, R>): HttpApp.Default<E, R> =>
  Effect.catchAllCause(app, (cause) =>
    Effect.gen(function* () {
      if (Cause.isInterrupted(cause)) return yield* Effect.failCause(cause);
      const context = yield* Correlation.current;
      if (Cause.defects(cause).length > 0) {
        // A defect: log the full cause here, hide the details from the wire.
        yield* Effect.logError("http request defect", cause);
        return defaultErrorResponse(undefined, context.correlationId);
      }
      if (!Cause.isFailType(cause)) return yield* Effect.failCause(cause);
      const failure = cause.error;
      // A declared business failure from the CQRS bridge: unwrap and re-fail
      // the inner error so the platform encodes it via the endpoint's
      // declared failure schema (422), skipping taxonomy mapping — which
      // would otherwise flatten failures whose `_tag` collides with a
      // taxonomy tag into generic problems.
      if (failure instanceof DeclaredBusinessFailure) {
        return yield* Effect.fail(failure.failure as E);
      }
      return isKnownError(failure)
        ? defaultErrorResponse(failure, context.correlationId)
        : yield* Effect.failCause(cause);
    }),
  );

/** Options for {@link standard}. */
export interface StandardOptions {
  /**
   * How requests are labelled in logs and metrics. Default: every request is
   * `(unmatched)` — pass `routeLabel(api)` (what {@link layer} does) to get
   * endpoint templates.
   */
  readonly routeLabel?: RouteLabel;
  /**
   * Correlation policy: which incoming ids are trusted and which headers the
   * response carries. Default: today's behavior (`sanitize`, `x-request-id`
   * and `x-correlation-id`). See {@link CorrelationOptions}.
   */
  readonly correlation?: CorrelationOptions;
}

/**
 * The standard middleware stack, outermost first: route label → correlation
 * → logging → metrics → problem mapping.
 */
export const standard = <E, R>(
  app: HttpApp.Default<E, R>,
  options?: StandardOptions,
): HttpApp.Default<E, R | HttpServerRequest.HttpServerRequest> =>
  withRouteLabel(options?.routeLabel ?? (() => UNMATCHED_ROUTE))(
    correlation(logger(metrics(problems(app))), options?.correlation),
  );

/**
 * The standard stack as an `HttpApi`-level middleware layer, labelling
 * requests with the mounted api's endpoint templates. Provide it next to
 * your api implementation (`serve`/`serveTest` already do):
 *
 * ```ts
 * HttpApiBuilder.serve().pipe(Layer.provide(Middleware.layer), ...)
 * ```
 */
export const layer: Layer.Layer<never, never, HttpApi.Api> = HttpApiBuilder.middleware(
  Effect.map(
    HttpApi.Api,
    ({ api }) =>
      <E, R>(app: HttpApp.Default<E, R>) =>
        standard(app, { routeLabel: routeLabel(api) }),
  ),
);
