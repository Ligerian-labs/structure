import { Effect } from "effect";
import type { RateLimitDecision, RateLimitRule, RateLimitStore } from "./rateLimit.js";
import { RateLimitStoreError } from "./rateLimit.js";
import { makeRedisClient, RedisError } from "./redis.js";

/**
 * Sliding window with block, atomic in one Lua invocation:
 *
 * - ZSET `<prefix>:w` holds the timestamps of consumed points inside the
 *   window; string `<prefix>:b` holds the block-until timestamp.
 * - Denied while blocked (remaining block time returned), denied and newly
 *   blocked when the window is full, otherwise one point is recorded.
 */
const SLIDING_WINDOW_SCRIPT = `
local windowKey = KEYS[1]
local blockKey = KEYS[2]
local points = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local block = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
local member = ARGV[5]

redis.call('ZREMRANGEBYSCORE', windowKey, 0, now - window)
local blockedUntil = tonumber(redis.call('GET', blockKey) or '0')
if blockedUntil > now then
  return {0, blockedUntil - now}
end
if redis.call('ZCARD', windowKey) >= points then
  local blockedFromNow = now + block
  redis.call('SET', blockKey, blockedFromNow, 'PX', block)
  return {0, block}
end
redis.call('ZADD', windowKey, now, member)
redis.call('PEXPIRE', windowKey, window)
return {1, 0}
`;

export interface RedisStoreOptions {
  readonly url: string;
  /** Key namespace. Default `rl`. */
  readonly prefix?: string;
  readonly connectTimeoutMillis?: number;
}

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * Redis-backed shared store: one budget across every replica, atomic through
 * the Lua script above. Transient connection failures surface as
 * `RateLimitStoreError` (the middleware fails open by default).
 */
export const makeRedisStore = (options: RedisStoreOptions): RateLimitStore => {
  const client = makeRedisClient({
    url: options.url,
    ...(options.connectTimeoutMillis === undefined
      ? {}
      : { connectTimeoutMillis: options.connectTimeoutMillis }),
  });
  const prefix = options.prefix ?? "rl";
  return {
    name: "redis",
    consume: (key, rule: RateLimitRule) =>
      client
        .eval(
          SLIDING_WINDOW_SCRIPT,
          [`${prefix}:w:${key}`, `${prefix}:b:${key}`],
          [
            String(rule.points),
            String(rule.windowMillis),
            String(rule.blockMillis),
            String(Date.now()),
            `${Date.now()}-${crypto.randomUUID()}`,
          ],
        )
        .pipe(
          Effect.flatMap((reply): Effect.Effect<RateLimitDecision, RedisError> => {
            if (
              Array.isArray(reply) &&
              reply.length === 2 &&
              isNumber(reply[0]) &&
              isNumber(reply[1])
            ) {
              return Effect.succeed({
                allowed: reply[0] === 1,
                retryAfterMillis: reply[1] ?? 0,
              });
            }
            return Effect.fail(new RedisError({ reason: "unexpected eval reply" }));
          }),
          Effect.mapError(
            (error): RateLimitStoreError =>
              new RateLimitStoreError({ store: "redis", cause: error }),
          ),
        ),
  };
};
