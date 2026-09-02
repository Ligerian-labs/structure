import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { layerSilent } from "@structure-ai/observability";
import { Readiness } from "@structure-ai/runtime";
import { Context, Effect, Exit, Layer, Metric, Schema, Scope } from "effect";
import {
  Api,
  ApiEndpoint,
  ApiGroup,
  clientIp,
  Health,
  HttpApiBuilder,
  HttpServer,
  makeInMemoryStore,
  type RateLimitStore,
  rateLimitLayer,
  serveTest,
} from "../src/index.js";

// --- store semantics (deterministic clock) -------------------------------------

describe("in-memory rate limit store", () => {
  const rule = { points: 2, windowMillis: 1_000, blockMillis: 5_000 };

  test("allows within budget, blocks with retryAfter, recovers after the block", async () => {
    let now = 1_000;
    const store = makeInMemoryStore({ now: () => now });
    const run = Effect.runPromise;
    expect((await run(store.consume("k", rule))).allowed).toBe(true);
    expect((await run(store.consume("k", rule))).allowed).toBe(true);
    const blocked = await run(store.consume("k", rule));
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMillis).toBe(5_000);
    // While blocked, even a fresh window does not help.
    now += 2_000;
    expect((await run(store.consume("k", rule))).allowed).toBe(false);
    // After the block (and window) expired, budget is fresh again.
    now += 4_000;
    expect((await run(store.consume("k", rule))).allowed).toBe(true);
  });

  test("keys are independent budgets", async () => {
    const store = makeInMemoryStore();
    const run = Effect.runPromise;
    expect((await run(store.consume("a", rule))).allowed).toBe(true);
    expect((await run(store.consume("a", rule))).allowed).toBe(true);
    expect((await run(store.consume("a", rule))).allowed).toBe(false);
    expect((await run(store.consume("b", rule))).allowed).toBe(true);
  });

  test("concurrent consumes of the last points are atomic", async () => {
    const tightRule = { points: 3, windowMillis: 10_000, blockMillis: 5_000 };
    const store = makeInMemoryStore();
    const decisions = await Promise.all(
      Array.from({ length: 8 }, () => Effect.runPromise(store.consume("race", tightRule))),
    );
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(3);
  });

  test("the sliding window releases points as they age out", async () => {
    let now = 1_000;
    const store = makeInMemoryStore({ now: () => now });
    const run = Effect.runPromise;
    const sliding = { points: 1, windowMillis: 100, blockMillis: 1 };
    expect((await run(store.consume("s", sliding))).allowed).toBe(true);
    expect((await run(store.consume("s", sliding))).allowed).toBe(false);
    now += 101;
    expect((await run(store.consume("s", sliding))).allowed).toBe(true);
  });
});

// --- middleware behavior over a real server ------------------------------------

const ping = ApiGroup.make("ping").add(
  ApiEndpoint.get("ping", "/ping").addSuccess(Schema.Struct({ ok: Schema.Literal(true) })),
);
const meta = ApiGroup.make("meta").add(
  ApiEndpoint.get("status", "/status").addSuccess(Schema.Struct({ up: Schema.Literal(true) })),
);

const api = Api.make("rate-limit-test").add(ping).add(meta).add(Health.group);

const PingLive = HttpApiBuilder.group(api, "ping", (handlers) =>
  handlers.handle("ping", () => Effect.succeed({ ok: true as const })),
);
const MetaLive = HttpApiBuilder.group(api, "meta", (handlers) =>
  handlers.handle("status", () => Effect.succeed({ up: true as const })),
);

let store: RateLimitStore;
let scope: Scope.CloseableScope | undefined;
let baseUrl = "";
let _closeServer: () => Promise<void>;

const buildServer = async (customStore: RateLimitStore): Promise<void> => {
  const TestLive = serveTest.pipe(
    Layer.provide(
      HttpApiBuilder.api(api).pipe(Layer.provide([PingLive, MetaLive, Health.layer(api)])),
    ),
    Layer.provide(
      rateLimitLayer({
        store: customStore,
        groups: [
          {
            label: "ping",
            rule: { points: 3, windowMillis: 10_000, blockMillis: 5_000 },
            match: (request) => request.url.startsWith("/ping"),
            key: (request) => request.headers["x-test-user"] ?? "anonymous",
          },
        ],
      }),
    ),
    Layer.provide(Readiness.layer),
    Layer.provide(layerSilent),
  );
  const theScope = Effect.runSync(Scope.make());
  const context = await Effect.runPromise(Layer.buildWithScope(TestLive, theScope));
  const server = Context.get(context, HttpServer.HttpServer);
  const address = server.address;
  if (address._tag !== "TcpAddress") throw new Error("expected tcp address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  scope = theScope;
};

beforeAll(async () => {
  store = makeInMemoryStore();
  await buildServer(store);
});

afterAll(async () => {
  if (scope !== undefined) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
});

const get = (path: string, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${baseUrl}${path}`, { headers });

describe("rate limit middleware", () => {
  test("consumes budget per principal and blocks with 429 + Retry-After", async () => {
    const user = `user-${crypto.randomUUID()}`;
    const first = await get("/ping", { "x-test-user": user });
    expect(first.status).toBe(200);
    const second = await get("/ping", { "x-test-user": user });
    expect(second.status).toBe(200);
    const third = await get("/ping", { "x-test-user": user });
    expect(third.status).toBe(200);
    const fourth = await get("/ping", { "x-test-user": user });
    expect(fourth.status).toBe(429);
    expect(fourth.headers.get("retry-after")).toBe("5");
    const body = (await fourth.json()) as { error: string; correlationId?: string };
    expect(body.error).toBe("TooManyRequests");
    expect(typeof body.correlationId).toBe("string");
  });

  test("OPTIONS preflights never consume budget", async () => {
    const user = `user-${crypto.randomUUID()}`;
    // Burn two of three points.
    await get("/ping", { "x-test-user": user });
    await get("/ping", { "x-test-user": user });
    // Preflights: whatever the platform answers, they must not consume.
    for (let index = 0; index < 5; index++) {
      await fetch(`${baseUrl}/ping`, {
        method: "OPTIONS",
        headers: { "x-test-user": user, origin: "https://app.example.com" },
      });
    }
    // The third point is still there.
    const afterOptions = await get("/ping", { "x-test-user": user });
    expect(afterOptions.status).toBe(200);
    const exhausted = await get("/ping", { "x-test-user": user });
    expect(exhausted.status).toBe(429);
  });

  test("health probes never consume budget", async () => {
    for (let index = 0; index < 8; index++) {
      const probe = await get("/health/live");
      expect(probe.status).toBe(200);
    }
    // An anonymous budget of 3 still intact: three pings succeed.
    const anonymous = `anon-${crypto.randomUUID()}`;
    for (let index = 0; index < 3; index++) {
      expect((await get("/ping", { "x-test-user": anonymous })).status).toBe(200);
    }
  });

  test("unmatched routes pass through untouched", async () => {
    for (let index = 0; index < 6; index++) {
      const response = await get("/status");
      expect(response.status).toBe(200);
    }
  });

  test("counters are tagged per route label", async () => {
    const blocked = Metric.counter("http_rate_limit_blocked_total").pipe(
      Metric.tagged("route", "ping"),
    );
    const state = await Effect.runPromise(Metric.value(blocked));
    expect((state as { count: number }).count).toBeGreaterThan(0);
  });

  test("clientIp prefers x-forwarded-for then falls back to the socket", () => {
    const request = {
      headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" },
      remoteAddress: { _tag: "Some", value: "10.0.0.2" },
    } as never;
    expect(clientIp(request)).toBe("203.0.113.9");
    const byRealIp = {
      headers: { "x-real-ip": "198.51.100.7" },
      remoteAddress: { _tag: "Some", value: "10.0.0.2" },
    } as never;
    expect(clientIp(byRealIp)).toBe("198.51.100.7");
    const bySocket = { headers: {}, remoteAddress: { _tag: "Some", value: "192.0.2.5" } } as never;
    expect(clientIp(bySocket)).toBe("192.0.2.5");
  });
});
