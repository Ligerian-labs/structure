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
