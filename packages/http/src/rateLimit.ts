import * as HttpApiBuilder from "@effect/platform/HttpApiBuilder";
import * as HttpApp from "@effect/platform/HttpApp";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import { Correlation } from "@structure-ai/observability";
import { Cause, Data, Effect, type Layer, Metric, Option } from "effect";
import { defaultErrorResponse } from "./errors.js";

/**
 * One rate-limit rule: `points` allowed per sliding `windowMillis`; once
 * exhausted, the key is blocked for `blockMillis` before budget accrues
 * again.
 */
export interface RateLimitRule {
  readonly points: number;
  readonly windowMillis: number;
  readonly blockMillis: number;
}

/**
 * The decision a store returns for one key: whether the request may proceed
 * and the budget state behind that answer (what `RateLimit-*` headers carry).
 */
export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Present when denied: how long until the caller may retry. */
  readonly retryAfterMillis: number;
  /** Why the request was denied; defaults to "exceeded". */
  readonly reason?: "exceeded" | "store-unavailable";
  /** The rule's `points`: the budget per window. */
  readonly limit: number;
  /** Points left in the current window after this decision (0 when denied). */
  readonly remaining: number;
  /**
   * Milliseconds until the budget is fully restored: every hit out of the
   * window and any block lifted. When denied, `retryAfterMillis <= resetMillis`.
   */
  readonly resetMillis: number;
}

/** Transient store failure (e.g. Redis unreachable). The middleware fails open. */
export class RateLimitStoreError extends Data.TaggedError("RateLimitStoreError")<{
  readonly store: string;
  readonly cause?: unknown;
}> {
  readonly classification: "transient" = "transient";
  override get message(): string {
    return `rate limit store ${this.store} failed`;
  }
}

/**
 * Store port. `consume` MUST make check-and-consume atomic (in-memory
 * mutation under one turn; Redis via a Lua script) — concurrent requests for
 * the same key must never both take the last point. `peek` answers the same
 * question without spending a point and without installing a block: a full
 * window is refused until its oldest hit ages out.
 */
export interface RateLimitStore {
  readonly name: string;
  readonly consume: (
    key: string,
    rule: RateLimitRule,
  ) => Effect.Effect<RateLimitDecision, RateLimitStoreError>;
  readonly peek: (
    key: string,
    rule: RateLimitRule,
  ) => Effect.Effect<RateLimitDecision, RateLimitStoreError>;
}

/** Keys a group charges for one request; `undefined` entries are dropped. */
export type RateLimitKeys = ReadonlyArray<string | undefined>;

interface RateLimitGroupBase {
  /** Bounded, low-cardinality label used in metrics, logs, and store keys. */
  readonly label: string;
  readonly rule: RateLimitRule;
  readonly match: (request: HttpServerRequest.HttpServerRequest) => boolean;
  /**
   * Consume-on-failure wall. When set, the group is peeked before the handler
   * (429 when any key is blocked) and charged after it only when the
   * predicate holds for the response — e.g. `response.status === 401` charges
   * refused logins and leaves successful ones free. A handler failure is
   * evaluated as the problem response this package renders for it
   * (`defaultErrorResponse`: `Unauthenticated`/`UnauthorizedProblem` → 401,
   * unknown errors → 500), then re-raised unchanged.
   */
  readonly consumeWhen?: (response: HttpServerResponse.HttpServerResponse) => boolean;
}

/**
 * Which requests a group covers, and how keys are derived per request.
 * Either `key` (one budget owner) or `keys` (several charged together, each
 * with its own budget under the group's rule — prefix them by kind, e.g.
 * `ip:…` and `email:…`, since they share one namespace). Return `undefined`
 * (or no keys) to leave a request unlimited; it still passes through the
 * group's match.
 */
export type RateLimitGroup = RateLimitGroupBase &
  (
    | {
        /** Principal id, IP, route+principal — whatever the app considers the budget owner. */
        readonly key: (
          request: HttpServerRequest.HttpServerRequest,
        ) => string | undefined | Effect.Effect<string | undefined>;
        readonly keys?: undefined;
      }
    | {
        readonly keys: (
          request: HttpServerRequest.HttpServerRequest,
        ) => RateLimitKeys | Effect.Effect<RateLimitKeys>;
        readonly key?: undefined;
      }
  );

export interface RateLimitOptions {
  readonly store: RateLimitStore;
  readonly groups: ReadonlyArray<RateLimitGroup>;
  /**
   * What happens when the store itself fails. Default: fail open (allow the
   * request), log a warning, count a store error — availability over
   * throttling. Set to `"deny"` to fail closed instead.
   */
  readonly onStoreError?: "allow" | "deny";
}

export interface ClientIpOptions {
  /**
   * `true` only when a proxy you operate terminates every connection and
   * appends the client address to `x-forwarded-for`: the rightmost hop (the
   * one your proxy wrote) is used, then `x-real-ip`. `false` ignores both
   * headers — any client can set them — and uses the socket address only.
   */
  readonly trustProxy: boolean;
}

/**
 * Client-IP extraction for rate-limit keys. The option is required so the
 * spoofable header path is never picked by accident.
 */
export const clientIp = (
  request: HttpServerRequest.HttpServerRequest,
  options: ClientIpOptions,
): string | undefined => {
  if (options.trustProxy) {
    const forwarded = request.headers["x-forwarded-for"];
    if (typeof forwarded === "string") {
      const hops = forwarded
        .split(",")
        .map((hop) => hop.trim())
        .filter((hop) => hop.length > 0);
      const rightmost = hops[hops.length - 1];
      if (rightmost !== undefined) return rightmost;
    }
    const real = request.headers["x-real-ip"];
    if (typeof real === "string" && real.trim().length > 0) return real.trim();
  }
  return Option.isSome(request.remoteAddress) ? request.remoteAddress.value : undefined;
};

/** Paths that never consume budget: health probes (plus `OPTIONS` preflights, handled by the middleware). */
const PROBE_PATHS: ReadonlySet<string> = new Set(["/health/live", "/health/ready"]);

const consumedCounter = Metric.counter("http_rate_limit_consumed_total", {
  incremental: true,
});
const blockedCounter = Metric.counter("http_rate_limit_blocked_total", {
  incremental: true,
});
const storeErrorCounter = Metric.counter("http_rate_limit_store_errors_total", {
  incremental: true,
});

const consumedFor = (label: string) => consumedCounter.pipe(Metric.tagged("route", label));
const blockedFor = (label: string) => blockedCounter.pipe(Metric.tagged("route", label));

const isProbe = (request: HttpServerRequest.HttpServerRequest): boolean => {
  const path = request.url.split("?")[0] ?? request.url;
  return PROBE_PATHS.has(path);
};

/**
 * The combined answer for every key of one request. `counted` is false when
 * the store failed for any key: the decision is then the configured fallback,
 * not a budget, and no quota headers are stamped.
 */
interface Outcome {
  readonly decision: RateLimitDecision;
  readonly counted: boolean;
}

const seconds = (millis: number): string => String(Math.max(0, Math.ceil(millis / 1_000)));

const quotaHeaders = (decision: RateLimitDecision): Record<string, string> => {
  const limit = String(decision.limit);
  const remaining = String(Math.max(0, decision.remaining));
  const reset = seconds(decision.resetMillis);
  return {
    "ratelimit-limit": limit,
    "ratelimit-remaining": remaining,
    "ratelimit-reset": reset,
    "x-ratelimit-limit": limit,
    "x-ratelimit-remaining": remaining,
    "x-ratelimit-reset": reset,
  };
};

const stamp = (
  response: HttpServerResponse.HttpServerResponse,
  outcome: Outcome,
): HttpServerResponse.HttpServerResponse =>
  outcome.counted
    ? HttpServerResponse.setHeaders(response, quotaHeaders(outcome.decision))
    : response;

/**
 * Rate-limiting middleware. Semantics:
 *
 * - `OPTIONS` preflights and health probes never consume budget;
 * - requests no group matches pass through untouched;
 * - every counted response — success or error — carries `RateLimit-Limit` /
 *   `RateLimit-Remaining` / `RateLimit-Reset` (seconds) and their
 *   `X-RateLimit-*` twins, stamped just before the response is sent;
 * - a denied request gets `429` with a problem body and `Retry-After` (seconds),
 *   and a warning log carrying the route label and correlation ids;
 * - a group with `consumeWhen` is peeked before the handler and charged after
 *   it only when the predicate holds for the response;
 * - store failures fail open (configurable) and are counted, never crash the request.
 *
 * Compose inside the standard stack (`Middleware.layer`) so correlation ids
 * and problem mapping still apply.
 */
export const rateLimit =
  (options: RateLimitOptions) =>
  <E, R>(app: HttpApp.Default<E, R>): HttpApp.Default<E, R | HttpServerRequest.HttpServerRequest> =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (request.method === "OPTIONS" || isProbe(request)) return yield* app;
      const group = options.groups.find((candidate) => candidate.match(request));
      if (group === undefined) return yield* app;
      const keys = (yield* keysOf(group, request)).map((key) => `${group.label}:${key}`);
      if (keys.length === 0) return yield* app;
      const consume = forKeys(options, group, keys, options.store.consume).pipe(
        Effect.tap(() => Metric.increment(consumedFor(group.label))),
      );
      const consumeWhen = group.consumeWhen;
      let outcome = yield* consumeWhen === undefined
        ? consume
        : forKeys(options, group, keys, options.store.peek);
      if (!outcome.decision.allowed) return yield* deny(group, outcome);
      yield* HttpApp.appendPreResponseHandler((_request, response) =>
        Effect.succeed(stamp(response, outcome)),
      );
      if (consumeWhen === undefined) return yield* app;
      const charge = (response: HttpServerResponse.HttpServerResponse): Effect.Effect<void> =>
        consumeWhen(response)
          ? Effect.map(consume, (charged) => {
              outcome = charged;
            })
          : Effect.void;
      return yield* app.pipe(
        Effect.tapErrorCause((cause) => charge(defaultErrorResponse(Cause.squash(cause)))),
        Effect.tap(charge),
      );
    });

const keysOf = (
  group: RateLimitGroup,
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.suspend(() => {
    const present = (keys: RateLimitKeys): ReadonlyArray<string> =>
      keys.filter((key): key is string => key !== undefined);
    if (group.keys !== undefined) {
      const value = group.keys(request);
      return Array.isArray(value)
        ? Effect.succeed(present(value))
        : Effect.map(value as Effect.Effect<RateLimitKeys>, present);
    }
    const value = group.key(request);
    return typeof value === "string" || value === undefined
      ? Effect.succeed(present([value]))
      : Effect.map(value, (key) => present([key]));
  });

const combine = (
  rule: RateLimitRule,
  decisions: ReadonlyArray<RateLimitDecision>,
): RateLimitDecision => {
  let allowed = true;
  let retryAfterMillis = 0;
  let remaining = rule.points;
  let resetMillis = 0;
  let reason: RateLimitDecision["reason"];
  for (const decision of decisions) {
    allowed = allowed && decision.allowed;
    retryAfterMillis = Math.max(retryAfterMillis, decision.retryAfterMillis);
    remaining = Math.min(remaining, decision.remaining);
    resetMillis = Math.max(resetMillis, decision.resetMillis);
    if (decision.reason === "store-unavailable") reason = "store-unavailable";
    else if (!decision.allowed && reason === undefined) reason = "exceeded";
  }
  return {
    allowed,
    retryAfterMillis,
    limit: rule.points,
    remaining,
    resetMillis,
    ...(reason !== undefined && { reason }),
  };
};

/** Runs one store call per key, absorbing store failures into the configured fallback. */
const forKeys = (
  options: RateLimitOptions,
  group: RateLimitGroup,
  keys: ReadonlyArray<string>,
  call: RateLimitStore["consume"],
): Effect.Effect<Outcome> =>
  Effect.forEach(keys, (key) =>
    call(key, group.rule).pipe(
      Effect.map((decision): Outcome => ({ decision, counted: true })),
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          yield* Metric.increment(storeErrorCounter);
          yield* Effect.logWarning("http rate limit store failed").pipe(
            Effect.annotateLogs({
              rateLimitStore: error.store,
              rateLimitRoute: group.label,
            }),
          );
          const decision: RateLimitDecision =
            (options.onStoreError ?? "allow") === "deny"
              ? {
                  allowed: false,
                  retryAfterMillis: 1_000,
                  reason: "store-unavailable",
                  limit: group.rule.points,
                  remaining: 0,
                  resetMillis: 1_000,
                }
              : {
                  allowed: true,
                  retryAfterMillis: 0,
                  limit: group.rule.points,
                  remaining: group.rule.points,
                  resetMillis: 0,
                };
          return { decision, counted: false } satisfies Outcome;
        }),
      ),
    ),
  ).pipe(
    Effect.map(
      (outcomes): Outcome => ({
        decision: combine(
          group.rule,
          outcomes.map((outcome) => outcome.decision),
        ),
        counted: outcomes.every((outcome) => outcome.counted),
      }),
    ),
  );

const deny = (
  group: RateLimitGroup,
  outcome: Outcome,
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  Effect.gen(function* () {
    yield* Metric.increment(blockedFor(group.label));
    const context = yield* Correlation.current;
    const retryAfterSeconds = Math.max(1, Math.ceil(outcome.decision.retryAfterMillis / 1_000));
    yield* Effect.logWarning("http rate limit block").pipe(
      Effect.annotateLogs({
        rateLimitRoute: group.label,
        retryAfterSeconds,
        ...(context.correlationId !== undefined && {
          correlationId: context.correlationId,
        }),
      }),
    );
    return stamp(
      HttpServerResponse.unsafeJson(
        {
          error: "TooManyRequests",
          message:
            outcome.decision.reason === "store-unavailable"
              ? "rate limit temporarily unavailable"
              : `rate limit exceeded, retry after ${retryAfterSeconds}s`,
          ...(context.correlationId !== undefined && {
            correlationId: context.correlationId,
          }),
        },
        {
          status: 429,
          headers: { "retry-after": String(retryAfterSeconds), "cache-control": "no-store" },
        },
      ),
      outcome,
    );
  });

/** {@link rateLimit} as an `HttpApi` middleware layer. */
export const layer = (options: RateLimitOptions): Layer.Layer<never> =>
  HttpApiBuilder.middleware(rateLimit(options));

// --- in-memory store -----------------------------------------------------------

interface MemoryEntry {
  readonly hits: Array<number>;
  blockedUntil: number;
}

const denied = (rule: RateLimitRule, retryAfterMillis: number, resetMillis: number) =>
  ({
    allowed: false,
    retryAfterMillis,
    limit: rule.points,
    remaining: 0,
    resetMillis,
  }) satisfies RateLimitDecision;

/** Time until every hit left the window and any block lifted. */
const resetOf = (
  hits: ReadonlyArray<number>,
  blockedUntil: number,
  rule: RateLimitRule,
  timestamp: number,
): number => {
  const newest = hits[hits.length - 1];
  const windowReset = newest === undefined ? 0 : newest + rule.windowMillis - timestamp;
  return Math.max(0, windowReset, blockedUntil - timestamp);
};

/**
 * In-memory sliding-window store for a single replica: bounded key map with
 * lazy sweep of expired entries on every consume, atomic within one event
 * loop turn. Pass `now` for deterministic tests.
 */
export const makeInMemoryStore = (
  options: { readonly maxKeys?: number; readonly now?: () => number } = {},
): RateLimitStore => {
  const maxKeys = options.maxKeys ?? 100_000;
  const now = options.now ?? (() => Date.now());
  const entries = new Map<string, MemoryEntry>();

  const sweep = (timestamp: number): void => {
    for (const [key, entry] of entries) {
      const windowStart = timestamp - 60 * 60 * 1_000;
      const stale = entry.blockedUntil <= timestamp && entry.hits.every((hit) => hit < windowStart);
      if (stale) entries.delete(key);
    }
  };

  const windowOf = (key: string, rule: RateLimitRule, timestamp: number) => {
    const entry = entries.get(key) ?? { hits: [], blockedUntil: 0 };
    const windowStart = timestamp - rule.windowMillis;
    return {
      hits: entry.hits.filter((hit) => hit > windowStart),
      blockedUntil: entry.blockedUntil,
    };
  };

  return {
    name: "memory",
    consume: (key, rule) =>
      Effect.sync((): RateLimitDecision => {
        const timestamp = now();
        if (entries.size > maxKeys) sweep(timestamp);
        const { hits, blockedUntil } = windowOf(key, rule, timestamp);
        if (blockedUntil > timestamp) {
          entries.set(key, { hits, blockedUntil });
          return denied(
            rule,
            blockedUntil - timestamp,
            resetOf(hits, blockedUntil, rule, timestamp),
          );
        }
        if (hits.length >= rule.points) {
          const blockedFromNow = timestamp + rule.blockMillis;
          entries.set(key, { hits, blockedUntil: blockedFromNow });
          return denied(rule, rule.blockMillis, resetOf(hits, blockedFromNow, rule, timestamp));
        }
        hits.push(timestamp);
        entries.set(key, { hits, blockedUntil: 0 });
        return {
          allowed: true,
          retryAfterMillis: 0,
          limit: rule.points,
          remaining: rule.points - hits.length,
          resetMillis: rule.windowMillis,
        };
      }),
    peek: (key, rule) =>
      Effect.sync((): RateLimitDecision => {
        const timestamp = now();
        const { hits, blockedUntil } = windowOf(key, rule, timestamp);
        const resetMillis = resetOf(hits, blockedUntil, rule, timestamp);
        if (blockedUntil > timestamp) return denied(rule, blockedUntil - timestamp, resetMillis);
        if (hits.length >= rule.points) {
          const oldest = hits[0];
          const untilOldestLeaves =
            oldest === undefined ? rule.windowMillis : oldest + rule.windowMillis - timestamp;
          return denied(rule, Math.max(1, untilOldestLeaves), resetMillis);
        }
        return {
          allowed: true,
          retryAfterMillis: 0,
          limit: rule.points,
          remaining: rule.points - hits.length,
          resetMillis,
        };
      }),
  };
};

/**
 * Chooses a store from an optional Redis URL: a URL yields the shared
 * Redis-backed store; no URL yields the in-memory store plus a startup
 * warning stating its single-replica scope.
 */
export const storeFromUrl = (url: string | undefined): Effect.Effect<RateLimitStore> =>
  Effect.gen(function* () {
    if (url === undefined) {
      yield* Effect.logWarning(
        "http rate limiting is using the in-memory store: budgets are per-replica, not shared across replicas",
      );
      return makeInMemoryStore();
    }
    const { makeRedisStore } = yield* Effect.promise(() => import("./rateLimitRedis.js"));
    return makeRedisStore({ url });
  });
