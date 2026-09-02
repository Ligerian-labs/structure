import * as HttpApiBuilder from "@effect/platform/HttpApiBuilder";
import type * as HttpApp from "@effect/platform/HttpApp";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import { Correlation } from "@structure-ai/observability";
import { Data, Effect, type Layer, Metric, Option } from "effect";

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

/** The decision a store returns for one consumption attempt. */
export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Present when denied: how long until the caller may retry. */
  readonly retryAfterMillis: number;
  /** Why the request was denied; defaults to "exceeded". */
  readonly reason?: "exceeded" | "store-unavailable";
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
 * Atomic consume port. Implementations MUST make check-and-consume atomic
 * (in-memory mutation under one turn; Redis via a Lua script) — concurrent
 * requests for the same key must never both take the last point.
 */
export interface RateLimitStore {
  readonly name: string;
  readonly consume: (
    key: string,
    rule: RateLimitRule,
  ) => Effect.Effect<RateLimitDecision, RateLimitStoreError>;
}

/**
 * Which requests a group covers, and how keys are derived per request.
 * Return `undefined` from `key` to leave a request unlimited (it still
 * passes through the group's match).
 */
export interface RateLimitGroup {
  /** Bounded, low-cardinality label used in metrics, logs, and store keys. */
  readonly label: string;
  readonly rule: RateLimitRule;
  readonly match: (request: HttpServerRequest.HttpServerRequest) => boolean;
  /** Principal id, IP, route+principal — whatever the app considers the budget owner. */
  readonly key: (
    request: HttpServerRequest.HttpServerRequest,
  ) => string | undefined | Effect.Effect<string | undefined>;
}

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

/** Best-effort client-IP extraction: proxy headers first, then the socket. */
export const clientIp = (request: HttpServerRequest.HttpServerRequest): string | undefined => {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    const first = forwarded.split(",")[0]?.trim();
    if (first !== undefined && first.length > 0) return first;
  }
  const real = request.headers["x-real-ip"];
  if (typeof real === "string" && real.length > 0) return real;
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
 * Rate-limiting middleware. Semantics:
 *
 * - `OPTIONS` preflights and health probes never consume budget;
 * - requests no group matches pass through untouched;
 * - a denied request gets `429` with a problem body and `Retry-After` (seconds),
 *   and a warning log carrying the route label and correlation ids;
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
      const keyRaw = yield* keyOf(group, request);
      if (keyRaw === undefined) return yield* app;
      const decision = yield* options.store.consume(`${group.label}:${keyRaw}`, group.rule).pipe(
        Effect.catchAll((error) =>
          Effect.gen(function* () {
            yield* Metric.increment(storeErrorCounter);
            yield* Effect.logWarning("http rate limit store failed").pipe(
              Effect.annotateLogs({
                rateLimitStore: error.store,
                rateLimitRoute: group.label,
              }),
            );
            if ((options.onStoreError ?? "allow") === "deny") {
              yield* Correlation.current;
              return yield* Effect.succeed<RateLimitDecision>({
                allowed: false,
                retryAfterMillis: 1_000,
                reason: "store-unavailable",
              });
            }
            return yield* Effect.succeed<RateLimitDecision>({
              allowed: true,
              retryAfterMillis: 0,
            });
          }),
        ),
      );
      if (decision.allowed) {
        yield* Metric.increment(consumedFor(group.label));
        return yield* app;
      }
      yield* Metric.increment(blockedFor(group.label));
      const context = yield* Correlation.current;
      const retryAfterSeconds = Math.max(1, Math.ceil(decision.retryAfterMillis / 1_000));
      yield* Effect.logWarning("http rate limit block").pipe(
        Effect.annotateLogs({
          rateLimitRoute: group.label,
          retryAfterSeconds,
          ...(context.correlationId !== undefined && {
            correlationId: context.correlationId,
          }),
        }),
      );
      return HttpServerResponse.unsafeJson(
        {
          error: "TooManyRequests",
          message:
            decision.reason === "store-unavailable"
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
      );
    });

const keyOf = (
  group: RateLimitGroup,
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<string | undefined> =>
  Effect.suspend(() => {
    const value = group.key(request);
    return typeof value === "string" || value === undefined ? Effect.succeed(value) : value;
  });

/** {@link rateLimit} as an `HttpApi` middleware layer. */
export const layer = (options: RateLimitOptions): Layer.Layer<never> =>
  HttpApiBuilder.middleware(rateLimit(options));

// --- in-memory store -----------------------------------------------------------

interface MemoryEntry {
  readonly hits: Array<number>;
  blockedUntil: number;
}

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

  return {
    name: "memory",
    consume: (key, rule) =>
      Effect.sync((): RateLimitDecision => {
        const timestamp = now();
        if (entries.size > maxKeys) sweep(timestamp);
        const entry = entries.get(key) ?? { hits: [], blockedUntil: 0 };
        const windowStart = timestamp - rule.windowMillis;
        const hits = entry.hits.filter((hit) => hit > windowStart);
        if (entry.blockedUntil > timestamp) {
          entries.set(key, { ...entry, hits });
          return { allowed: false, retryAfterMillis: entry.blockedUntil - timestamp };
        }
        if (hits.length >= rule.points) {
          const blockedUntil = timestamp + rule.blockMillis;
          entries.set(key, { hits, blockedUntil });
          return { allowed: false, retryAfterMillis: rule.blockMillis };
        }
        hits.push(timestamp);
        entries.set(key, { hits, blockedUntil: 0 });
        return { allowed: true, retryAfterMillis: 0 };
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
