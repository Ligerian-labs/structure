import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { makeRedisStore } from "../src/rateLimitRedis.js";
import { makeRedisClient } from "../src/redis.js";

const redisUrl = process.env.REDIS_URL;
const gated = redisUrl === undefined ? describe.skip : describe;

const sleep = (millis: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, millis));

gated("Redis rate limit store (needs REDIS_URL)", () => {
  test("answers PING through the RESP client", async () => {
    const client = makeRedisClient({ url: redisUrl as string });
    try {
      const pong = await Effect.runPromise(client.eval("return 1", [], []));
      expect(pong).toBe(1);
    } finally {
      client.close();
    }
  });

  test("enforces the sliding window and block over the wire", async () => {
    const store = makeRedisStore({ url: redisUrl as string, prefix: `rlt-${crypto.randomUUID()}` });
    const rule = { points: 2, windowMillis: 150, blockMillis: 120 };
    const key = `k-${crypto.randomUUID()}`;
    expect((await Effect.runPromise(store.consume(key, rule))).allowed).toBe(true);
    expect((await Effect.runPromise(store.consume(key, rule))).allowed).toBe(true);
    const blocked = await Effect.runPromise(store.consume(key, rule));
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMillis).toBeGreaterThan(0);
    // After both the block and the window have passed, budget accrues again.
    await sleep(250);
    expect((await Effect.runPromise(store.consume(key, rule))).allowed).toBe(true);
  });

  test("shares one budget across store instances (cross-replica)", async () => {
    const prefix = `rlx-${crypto.randomUUID()}`;
    const replicaA = makeRedisStore({ url: redisUrl as string, prefix });
    const replicaB = makeRedisStore({ url: redisUrl as string, prefix });
    const rule = { points: 3, windowMillis: 60_000, blockMillis: 1_000 };
    const key = `shared-${crypto.randomUUID()}`;
    // Replicas alternate: a budget spent on A blocks on B.
    expect((await Effect.runPromise(replicaA.consume(key, rule))).allowed).toBe(true);
    expect((await Effect.runPromise(replicaB.consume(key, rule))).allowed).toBe(true);
    expect((await Effect.runPromise(replicaA.consume(key, rule))).allowed).toBe(true);
    expect((await Effect.runPromise(replicaB.consume(key, rule))).allowed).toBe(false);
    expect((await Effect.runPromise(replicaA.consume(key, rule))).allowed).toBe(false);
  });

  test("concurrent consumes never overdraw the budget", async () => {
    const store = makeRedisStore({ url: redisUrl as string, prefix: `rlc-${crypto.randomUUID()}` });
    const rule = { points: 4, windowMillis: 60_000, blockMillis: 1_000 };
    const key = `race-${crypto.randomUUID()}`;
    const decisions = await Promise.all(
      Array.from({ length: 10 }, () => Effect.runPromise(store.consume(key, rule))),
    );
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(4);
  });

  test("decisions carry limit, remaining and resetMillis", async () => {
    const store = makeRedisStore({ url: redisUrl as string, prefix: `rlq-${crypto.randomUUID()}` });
    const rule = { points: 3, windowMillis: 60_000, blockMillis: 1_000 };
    const key = `quota-${crypto.randomUUID()}`;
    const first = await Effect.runPromise(store.consume(key, rule));
    expect(first).toMatchObject({ allowed: true, limit: 3, remaining: 2, resetMillis: 60_000 });
    await Effect.runPromise(store.consume(key, rule));
    const last = await Effect.runPromise(store.consume(key, rule));
    expect(last).toMatchObject({ allowed: true, limit: 3, remaining: 0 });
    const denied = await Effect.runPromise(store.consume(key, rule));
    expect(denied).toMatchObject({ allowed: false, limit: 3, remaining: 0 });
    expect(denied.retryAfterMillis).toBeGreaterThan(0);
    expect(denied.retryAfterMillis).toBeLessThanOrEqual(1_000);
    // The window outlasts the block here, so the full reset is the window's.
    expect(denied.resetMillis).toBeGreaterThan(59_000);
  });

  test("peek reports the budget without consuming and without installing a block", async () => {
    const store = makeRedisStore({ url: redisUrl as string, prefix: `rlp-${crypto.randomUUID()}` });
    const rule = { points: 2, windowMillis: 60_000, blockMillis: 10_000 };
    const key = `peek-${crypto.randomUUID()}`;
    const run = Effect.runPromise;
    expect(await run(store.peek(key, rule))).toMatchObject({
      allowed: true,
      remaining: 2,
      resetMillis: 0,
    });
    for (let index = 0; index < 5; index++) await run(store.peek(key, rule));
    expect((await run(store.consume(key, rule))).remaining).toBe(1);
    expect((await run(store.peek(key, rule))).remaining).toBe(1);
    expect((await run(store.consume(key, rule))).remaining).toBe(0);
    // Window full, no block: refused until the oldest hit ages out (well under the window).
    const full = await run(store.peek(key, rule));
    expect(full.allowed).toBe(false);
    expect(full.retryAfterMillis).toBeGreaterThan(0);
    expect(full.retryAfterMillis).toBeLessThanOrEqual(60_000);
    // A consume installs the block; peek then reports the remaining block time.
    const blocked = await run(store.consume(key, rule));
    expect(blocked.allowed).toBe(false);
    const peekedWhileBlocked = await run(store.peek(key, rule));
    expect(peekedWhileBlocked.allowed).toBe(false);
    expect(peekedWhileBlocked.retryAfterMillis).toBeLessThanOrEqual(10_000);
    expect(peekedWhileBlocked.retryAfterMillis).toBeGreaterThan(9_000);
  });

  test("surfaces unreachable servers as transient store errors", async () => {
    const store = makeRedisStore({
      url: "redis://127.0.0.1:1",
      prefix: "rl-down",
      connectTimeoutMillis: 500,
    });
    const error = await Effect.runPromise(
      Effect.flip(store.consume("any", { points: 1, windowMillis: 1_000, blockMillis: 1_000 })),
    );
    expect(error._tag).toBe("RateLimitStoreError");
  });
});

gated("Redis rate limit store: zero-block rules (needs REDIS_URL)", () => {
  test("a rule with blockMillis 0 denies an exhausted window without installing a block key", async () => {
    const prefix = `rlz-${crypto.randomUUID()}`;
    const store = makeRedisStore({ url: redisUrl as string, prefix });
    // The shape every template wall uses: a window, no extra lockout.
    const rule = { points: 2, windowMillis: 60_000, blockMillis: 0 };
    const key = `zero-${crypto.randomUUID()}`;
    expect((await Effect.runPromise(store.consume(key, rule))).allowed).toBe(true);
    expect((await Effect.runPromise(store.consume(key, rule))).allowed).toBe(true);
    const denied = await Effect.runPromise(store.consume(key, rule));
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    // Retry-After counts down the window: until the oldest hit leaves, never 0.
    expect(denied.retryAfterMillis).toBeGreaterThan(0);
    expect(denied.retryAfterMillis).toBeLessThanOrEqual(60_000);
    expect(denied.resetMillis).toBeGreaterThanOrEqual(denied.retryAfterMillis);
    // Denied stays denied: a further consume is a decision, never a store error.
    const again = await Effect.runPromise(store.consume(key, rule));
    expect(again.allowed).toBe(false);
    expect((await Effect.runPromise(store.peek(key, rule))).allowed).toBe(false);
    // No block key was written: a zero block means "no block", not "expire now".
    const client = makeRedisClient({ url: redisUrl as string });
    try {
      const exists = await Effect.runPromise(
        client.eval("return redis.call('EXISTS', KEYS[1])", [`${prefix}:b:${key}`], []),
      );
      expect(exists).toBe(0);
    } finally {
      client.close();
    }
  });

  test("a zero-block window refills once its oldest hit ages out", async () => {
    const store = makeRedisStore({
      url: redisUrl as string,
      prefix: `rlzw-${crypto.randomUUID()}`,
    });
    const rule = { points: 1, windowMillis: 150, blockMillis: 0 };
    const key = `refill-${crypto.randomUUID()}`;
    expect((await Effect.runPromise(store.consume(key, rule))).allowed).toBe(true);
    const denied = await Effect.runPromise(store.consume(key, rule));
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMillis).toBeLessThanOrEqual(150);
    await sleep(200);
    expect((await Effect.runPromise(store.consume(key, rule))).allowed).toBe(true);
  });
});
