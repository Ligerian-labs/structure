/**
 * `@structure-ai/client` — a typed, opinionated API client derived from an
 * `HttpApi` definition (`@effect/platform`), for consumers that share the api
 * type at compile time (e.g. a frontend in the same workspace).
 *
 * There is no code generation: signatures are derived from the `Api` type, so
 * any change to the api breaks client compilation — drift is caught by `tsc`,
 * not by a generation step. On top of the typed call surface this package adds
 * the transport opinions the platform contract prescribes:
 *
 * - a correlation id on every request (reusing the ambient
 *   `@structure-ai/observability` correlation when one is active);
 * - an optional bearer token, evaluated per request;
 * - a per-attempt deadline;
 * - bounded exponential backoff **with jitter** for transient transport
 *   failures only (network errors, 5xx responses, dispatch timeouts, and
 *   failures whose decoded error carries `classification: "transient"`).
 *   Business failures (422) and permanent problems are never retried — the
 *   caller sees them on the first attempt.
 */

import type * as HttpApi from "@effect/platform/HttpApi";
import * as HttpApiClient from "@effect/platform/HttpApiClient";
import type { HttpApiGroup } from "@effect/platform/HttpApiGroup";
import * as HttpClient from "@effect/platform/HttpClient";
import * as HttpClientError from "@effect/platform/HttpClientError";
import * as HttpClientRequest from "@effect/platform/HttpClientRequest";
import { Correlation } from "@structure-ai/observability";
import { Data, Duration, type Duration as Duration_, Effect, Schedule } from "effect";

/**
 * The per-attempt deadline was exceeded. Transient: a retry may succeed —
 * pair command retries with an `x-idempotency-key` (the CQRS bridge forwards
 * it into the dispatch envelope).
 */
export class RequestTimeout extends Data.TaggedError("RequestTimeout")<{
  readonly timeoutMillis: number;
}> {
  readonly classification = "transient" as const;
}

/** Retry policy for transient transport failures. */
export interface RetryOptions {
  /** Total attempts per call (including the first). Default: 3. */
  readonly attempts?: number;
  /** Base backoff delay, doubled per attempt. Default: `100` millis. */
  readonly baseDelay?: Duration_.DurationInput;
  /** Upper bound for a single backoff delay. Default: `5000` millis. */
  readonly maxDelay?: Duration_.DurationInput;
}

/** Options for {@link make}. */
export interface ClientOptions {
  /** Base url of the api server, e.g. `http://127.0.0.1:3000`. */
  readonly baseUrl: string | URL;
  /** Static headers set on every request. */
  readonly headers?: Record<string, string>;
  /**
   * Bearer token provider, evaluated per request so short-lived tokens work
   * without rebuilding the client.
   */
  readonly bearer?: () => string | Promise<string>;
  /** Per-attempt deadline. Exceeding it fails with {@link RequestTimeout}. */
  readonly timeout?: Duration_.DurationInput;
  /** Retry policy for transient transport failures. Default: 3 attempts. */
  readonly retry?: RetryOptions;
}

const defaultAttempts = 3;
const defaultBaseDelay = 100;
const defaultMaxDelay = 5_000;

const hasField = (u: unknown, key: string): u is Record<string, unknown> =>
  typeof u === "object" && u !== null && key in u;

/**
 * Transient by the platform contract: network-level failures, 5xx responses,
 * dispatch timeouts (504 problems carry `error: "DispatchTimeout"`), our own
 * per-attempt timeouts, and any decoded error that declares
 * `classification: "transient"`. Everything else — business failures,
 * validation, authorization — is permanent or a conflict and is not retried.
 */
const isTransient = (error: unknown): boolean => {
  if (error instanceof RequestTimeout) return true;
  if (HttpClientError.isHttpClientError(error)) {
    // RequestError: the request never completed (connection refused, dns, ...).
    if (error._tag === "RequestError") return true;
    // ResponseError: non-2xx the client could not map to a declared schema.
    if (error._tag === "ResponseError") return error.response.status >= 500;
  }
  if (hasField(error, "error") && error.error === "DispatchTimeout") return true;
  if (hasField(error, "classification") && error.classification === "transient") return true;
  return false;
};

const retrySchedule = (options: RetryOptions | undefined): Schedule.Schedule<unknown, unknown> =>
  Schedule.exponential(options?.baseDelay ?? defaultBaseDelay).pipe(
    Schedule.jittered,
    Schedule.modifyDelay((delay) => Duration.min(delay, options?.maxDelay ?? defaultMaxDelay)),
    Schedule.intersect(Schedule.recurs((options?.attempts ?? defaultAttempts) - 1)),
    Schedule.whileInput(isTransient),
  );

const requestPipeline =
  (options: ClientOptions) =>
  (client: HttpClient.HttpClient): HttpClient.HttpClient =>
    HttpClient.mapRequestEffect(client, (request) =>
      Effect.gen(function* () {
        const correlation = yield* Correlation.current;
        const correlationId = correlation.correlationId ?? Correlation.newId();
        let next = HttpClientRequest.setHeader(request, "x-correlation-id", correlationId);
        if (options.headers !== undefined) {
          next = HttpClientRequest.setHeaders(next, options.headers);
        }
        const bearer = options.bearer;
        if (bearer !== undefined) {
          const token = yield* Effect.promise(async () => bearer());
          next = HttpClientRequest.setHeader(next, "authorization", `Bearer ${token}`);
        }
        return next;
      }),
    );

const responsePipeline =
  (options: ClientOptions) =>
  (effect: Effect.Effect<unknown, unknown>): Effect.Effect<unknown, unknown> => {
    const attempt =
      options.timeout === undefined
        ? effect
        : effect.pipe(
            Effect.timeoutFail({
              duration: options.timeout,
              onTimeout: () =>
                new RequestTimeout({ timeoutMillis: Duration.toMillis(options.timeout ?? 0) }),
            }),
          );
    return attempt.pipe(Effect.retry(retrySchedule(options.retry)));
  };

type EndpointFn = (...args: never[]) => Effect.Effect<unknown, unknown>;

/**
 * Wraps every endpoint method of the built client (recursing into groups)
 * with the per-call pipeline: deadline first, then bounded retries. Wrapping
 * the whole call — not the platform's `transformResponse`, which only sees
 * the decode step of an already-executed request — is what lets a retry
 * re-execute the request and a deadline interrupt it mid-flight.
 */
const wrapEndpointCalls = (
  value: unknown,
  wrap: (effect: Effect.Effect<unknown, unknown>) => Effect.Effect<unknown, unknown>,
): unknown => {
  if (typeof value === "function") {
    const endpoint = value as EndpointFn;
    return (...args: never[]) => wrap(endpoint(...args));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, member]) => [key, wrapEndpointCalls(member, wrap)]),
    );
  }
  return value;
};

/**
 * Derives a fully-typed client from an `Api` definition. The returned effect
 * needs an `HttpClient` — provide `FetchHttpClient.layer` (browser and Bun).
 *
 * ```ts
 * import { FetchHttpClient } from "@effect/platform/FetchHttpClient";
 * import { Effect } from "effect";
 *
 * const program = Effect.gen(function* () {
 *   const client = yield* StructureClient.make(api, {
 *     baseUrl: "http://127.0.0.1:3000",
 *     bearer: () => getToken(),
 *   });
 *   const placed = yield* client.orders.placeOrder({ name: "x", sku: "sku-1" });
 * });
 *
 * program.pipe(Effect.provide(FetchHttpClient.layer));
 * ```
 */
export const make = <ApiId extends string, Groups extends HttpApiGroup.Any, Error, ApiR>(
  api: HttpApi.HttpApi<ApiId, Groups, Error, ApiR>,
  options: ClientOptions,
) =>
  Effect.map(
    HttpApiClient.make(api, {
      baseUrl: options.baseUrl,
      transformClient: requestPipeline(options),
    }),
    (client) => wrapEndpointCalls(client, responsePipeline(options)) as typeof client,
  );
