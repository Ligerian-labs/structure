import { Effect } from "effect";
import type { RateLimitDecision, RateLimitRule, RateLimitStore } from "./rateLimit.js";
import { RateLimitStoreError } from "./rateLimit.js";
import { makeRedisClient, RedisError } from "./redis.js";

/**
 * Sliding window with block, atomic in one Lua invocation. Both scripts share
 * the same layout and reply shape:
 *
 * - ZSET `<prefix>:w` holds the timestamps of consumed points inside the
 *   window; string `<prefix>:b` holds the block-until timestamp.
 * - Reply: `{allowed, retryAfterMillis, remaining, resetMillis}` where
 *   `resetMillis` is the time until every hit left the window and any block
 *   lifted.
 *
 * `consume`: denied while blocked (remaining block time returned), denied and
 * newly blocked when the window is full, otherwise one point is recorded.
 */
const CONSUME_SCRIPT = `
local windowKey = KEYS[1]
local blockKey = KEYS[2]
local points = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local block = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
local member = ARGV[5]

redis.call('ZREMRANGEBYSCORE', windowKey, 0, now - window)
local used = redis.call('ZCARD', windowKey)
local newest = redis.call('ZRANGE', windowKey, -1, -1, 'WITHSCORES')
local windowReset = 0
if newest[2] then windowReset = tonumber(newest[2]) + window - now end
local blockedUntil = tonumber(redis.call('GET', blockKey) or '0')
if blockedUntil > now then
  local retry = blockedUntil - now
  return {0, retry, 0, math.max(retry, windowReset)}
end
if used >= points then
  redis.call('SET', blockKey, now + block, 'PX', block)
  return {0, block, 0, math.max(block, windowReset)}
end
redis.call('ZADD', windowKey, now, member)
redis.call('PEXPIRE', windowKey, window)
return {1, 0, points - used - 1, window}
`;

/**
 * `peek`: same answer without spending a point or installing a block. A full
 * window is refused until its oldest hit ages out (expired hits are pruned,
 * which changes nothing observable).
 */
const PEEK_SCRIPT = `
local windowKey = KEYS[1]
local blockKey = KEYS[2]
local points = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

redis.call('ZREMRANGEBYSCORE', windowKey, 0, now - window)
local used = redis.call('ZCARD', windowKey)
local newest = redis.call('ZRANGE', windowKey, -1, -1, 'WITHSCORES')
local windowReset = 0
if newest[2] then windowReset = tonumber(newest[2]) + window - now end
local blockedUntil = tonumber(redis.call('GET', blockKey) or '0')
if blockedUntil > now then
  local retry = blockedUntil - now
  return {0, retry, 0, math.max(retry, windowReset)}
end
if used >= points then
  local oldest = redis.call('ZRANGE', windowKey, 0, 0, 'WITHSCORES')
  local retry = window
  if oldest[2] then retry = tonumber(oldest[2]) + window - now end
  return {0, math.max(1, retry), 0, windowReset}
end
return {1, 0, points - used, windowReset}
`;

export interface RedisStoreOptions {
  readonly url: string;
  /** Key namespace. Default `rl`. */
  readonly prefix?: string;
  readonly connectTimeoutMillis?: number;
}

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const decode = (
  reply: unknown,
  rule: RateLimitRule,
): Effect.Effect<RateLimitDecision, RedisError> => {
  if (
    Array.isArray(reply) &&
    reply.length === 4 &&
    isNumber(reply[0]) &&
    isNumber(reply[1]) &&
    isNumber(reply[2]) &&
    isNumber(reply[3])
  ) {
    return Effect.succeed({
      allowed: reply[0] === 1,
      retryAfterMillis: reply[1],
      limit: rule.points,
      remaining: reply[2],
      resetMillis: reply[3],
    });
  }
  return Effect.fail(new RedisError({ reason: "unexpected eval reply" }));
};

/**
 * Redis-backed shared store: one budget across every replica, atomic through
 * the Lua scripts above. Transient connection failures surface as
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
  const keysOf = (key: string): ReadonlyArray<string> => [
    `${prefix}:w:${key}`,
    `${prefix}:b:${key}`,
  ];
  const run = (
    script: string,
    key: string,
    rule: RateLimitRule,
    args: ReadonlyArray<string>,
  ): Effect.Effect<RateLimitDecision, RateLimitStoreError> =>
    client.eval(script, keysOf(key), args).pipe(
      Effect.flatMap((reply) => decode(reply, rule)),
      Effect.mapError(
        (error): RateLimitStoreError => new RateLimitStoreError({ store: "redis", cause: error }),
      ),
    );
  return {
    name: "redis",
    consume: (key, rule) => {
      const now = Date.now();
      return run(CONSUME_SCRIPT, key, rule, [
        String(rule.points),
        String(rule.windowMillis),
        String(rule.blockMillis),
        String(now),
        `${now}-${crypto.randomUUID()}`,
      ]);
    },
    peek: (key, rule) =>
      run(PEEK_SCRIPT, key, rule, [
        String(rule.points),
        String(rule.windowMillis),
        String(Date.now()),
      ]),
  };
};
