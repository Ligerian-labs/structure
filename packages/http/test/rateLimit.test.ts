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
  UnauthorizedProblem,
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

  test("decisions carry the budget state: limit, remaining, resetMillis", async () => {
    let now = 1_000;
    const store = makeInMemoryStore({ now: () => now });
    const run = Effect.runPromise;
    const first = await run(store.consume("q", rule));
    expect(first).toMatchObject({ allowed: true, limit: 2, remaining: 1, resetMillis: 1_000 });
    now += 400;
    const second = await run(store.consume("q", rule));
    expect(second).toMatchObject({ allowed: true, limit: 2, remaining: 0, resetMillis: 1_000 });
    const denied = await run(store.consume("q", rule));
    expect(denied).toMatchObject({
      allowed: false,
      limit: 2,
      remaining: 0,
      retryAfterMillis: 5_000,
    });
    // Fully reset once the block lifts (the block outlasts the window here).
    expect(denied.resetMillis).toBe(5_000);
  });

  test("a zero-block rule denies with Retry-After counting down the window, never 0", async () => {
    let now = 1_000_000;
    const store = makeInMemoryStore({ now: () => now });
    const rule = { points: 2, windowMillis: 60_000, blockMillis: 0 };
    await Effect.runPromise(store.consume("k", rule));
    now += 10_000;
    await Effect.runPromise(store.consume("k", rule));
    now += 10_000;
    const denied = await Effect.runPromise(store.consume("k", rule));
    expect(denied.allowed).toBe(false);
    // The oldest hit leaves the window 40s from now.
    expect(denied.retryAfterMillis).toBe(40_000);
    expect(denied.resetMillis).toBe(50_000);
    now += 40_001;
    expect((await Effect.runPromise(store.consume("k", rule))).allowed).toBe(true);
  });

  test("past maxKeys the store evicts the least recently used key, so fresh keys never grow it", async () => {
    let now = 5_000_000;
    const store = makeInMemoryStore({ maxKeys: 100, now: () => now });
    const rule = { points: 5, windowMillis: 60_000, blockMillis: 0 };
    for (let index = 0; index < 1_000; index++) {
      await Effect.runPromise(store.consume(`flood-${index}`, rule));
    }
    expect(store.size()).toBeLessThanOrEqual(100);
    // The most recent keys survive with their budget; the oldest were evicted.
    expect((await Effect.runPromise(store.peek("flood-999", rule))).remaining).toBe(4);
    expect((await Effect.runPromise(store.peek("flood-0", rule))).remaining).toBe(5);
    // A key touched again is the most recent, so it outlives a later flood.
    await Effect.runPromise(store.consume("flood-950", rule));
    for (let index = 1_000; index < 1_098; index++) {
      await Effect.runPromise(store.consume(`flood-${index}`, rule));
    }
    expect((await Effect.runPromise(store.peek("flood-950", rule))).remaining).toBe(3);
    now += 1;
    expect(store.size()).toBeLessThanOrEqual(100);
  });

  test("the sweep of stale entries is periodic, not per consume", async () => {
    let now = 9_000_000;
    const store = makeInMemoryStore({ maxKeys: 10, now: () => now, sweepIntervalMillis: 1_000 });
    const rule = { points: 1, windowMillis: 100, blockMillis: 0 };
    for (let index = 0; index < 10; index++) {
      await Effect.runPromise(store.consume(`k-${index}`, rule));
    }
    expect(store.size()).toBe(10);
    // Every hit is out of the window, but the sweep does not run until its interval elapsed.
    now += 500;
    await Effect.runPromise(store.consume("k-0", rule));
    expect(store.size()).toBe(10);
    now += 600;
    await Effect.runPromise(store.consume("k-0", rule));
    // The sweep ran: k-0 (just touched) survives, the nine stale entries are gone.
    expect(store.size()).toBe(1);
  });

  test("a denied decision never reports a reset shorter than its retry-after, even with no points", async () => {
    const store = makeInMemoryStore({ now: () => 7_000_000 });
    const denied = await Effect.runPromise(
      store.consume("none", { points: 0, windowMillis: 60_000, blockMillis: 0 }),
    );
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMillis).toBe(60_000);
    expect(denied.resetMillis).toBeGreaterThanOrEqual(denied.retryAfterMillis);
  });

  test("peek reports the budget without consuming it", async () => {
    let now = 1_000;
    const store = makeInMemoryStore({ now: () => now });
    const run = Effect.runPromise;
    const untouched = await run(store.peek("p", rule));
    expect(untouched).toMatchObject({ allowed: true, limit: 2, remaining: 2, resetMillis: 0 });
    // Peeking many times never spends a point.
    for (let index = 0; index < 5; index++) await run(store.peek("p", rule));
    expect((await run(store.consume("p", rule))).remaining).toBe(1);
    expect((await run(store.peek("p", rule))).remaining).toBe(1);
    expect((await run(store.consume("p", rule))).remaining).toBe(0);
    // Window full but no block installed: peek refuses until the oldest hit ages out,
    // and still installs no block.
    now += 300;
    const full = await run(store.peek("p", rule));
    expect(full.allowed).toBe(false);
    expect(full.retryAfterMillis).toBe(700);
    expect(full.remaining).toBe(0);
    now += 701;
    expect((await run(store.peek("p", rule))).allowed).toBe(true);
    // Once a consume installed a block, peek reports it with the remaining block time.
    await run(store.consume("p", rule));
    await run(store.consume("p", rule));
    const blocked = await run(store.consume("p", rule));
    expect(blocked.allowed).toBe(false);
    now += 1_000;
    const peekedWhileBlocked = await run(store.peek("p", rule));
    expect(peekedWhileBlocked.allowed).toBe(false);
    expect(peekedWhileBlocked.retryAfterMillis).toBe(4_000);
  });
});

// --- clientIp ------------------------------------------------------------------

describe("clientIp", () => {
  const request = (headers: Record<string, string>, socket = "10.0.0.2") =>
    ({ headers, remoteAddress: { _tag: "Some", value: socket } }) as never;

  test("without trustProxy, forwarding headers are ignored: socket address only", () => {
    expect(
      clientIp(request({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }), { trustProxy: false }),
    ).toBe("10.0.0.2");
    expect(clientIp(request({ "x-real-ip": "198.51.100.7" }), { trustProxy: false })).toBe(
      "10.0.0.2",
    );
    expect(clientIp(request({}, "192.0.2.5"), { trustProxy: false })).toBe("192.0.2.5");
  });

  test("with trustProxy, the rightmost x-forwarded-for hop wins, trimmed", () => {
    expect(
      clientIp(request({ "x-forwarded-for": "203.0.113.9, 198.51.100.4 , 10.0.0.1 " }), {
        trustProxy: true,
      }),
    ).toBe("10.0.0.1");
    expect(clientIp(request({ "x-forwarded-for": "203.0.113.9" }), { trustProxy: true })).toBe(
      "203.0.113.9",
    );
    // Trailing separators or blanks never yield an empty hop.
    expect(clientIp(request({ "x-forwarded-for": "203.0.113.9, " }), { trustProxy: true })).toBe(
      "203.0.113.9",
    );
  });

  test("with trustProxy, x-real-ip is honored only when x-forwarded-for is absent", () => {
    expect(clientIp(request({ "x-real-ip": " 198.51.100.7 " }), { trustProxy: true })).toBe(
      "198.51.100.7",
    );
    expect(
      clientIp(request({ "x-forwarded-for": "203.0.113.9", "x-real-ip": "198.51.100.7" }), {
        trustProxy: true,
      }),
    ).toBe("203.0.113.9");
    expect(clientIp(request({}, "192.0.2.5"), { trustProxy: true })).toBe("192.0.2.5");
  });

  test("returns undefined when neither header nor socket address is known", () => {
    const socketless = { headers: {}, remoteAddress: { _tag: "None" } } as never;
    expect(clientIp(socketless, { trustProxy: false })).toBeUndefined();
    expect(clientIp(socketless, { trustProxy: true })).toBeUndefined();
  });
});

// --- middleware behavior over a real server ------------------------------------

const ping = ApiGroup.make("ping").add(
  ApiEndpoint.get("ping", "/ping").addSuccess(Schema.Struct({ ok: Schema.Literal(true) })),
);
const meta = ApiGroup.make("meta").add(
  ApiEndpoint.get("status", "/status").addSuccess(Schema.Struct({ up: Schema.Literal(true) })),
);
const byIp = ApiGroup.make("byIp")
  .add(ApiEndpoint.get("ip", "/ip").addSuccess(Schema.Struct({ ok: Schema.Literal(true) })))
  .add(
    ApiEndpoint.get("ipTrusted", "/ip-trusted").addSuccess(
      Schema.Struct({ ok: Schema.Literal(true) }),
    ),
  );
const LoginPayload = Schema.Struct({ email: Schema.String, password: Schema.String });
const login = ApiGroup.make("login").add(
  ApiEndpoint.post("login", "/login")
    .setPayload(LoginPayload)
    .addSuccess(Schema.Struct({ token: Schema.String }))
    .addError(UnauthorizedProblem),
);

const api = Api.make("rate-limit-test").add(ping).add(meta).add(byIp).add(login).add(Health.group);

const PingLive = HttpApiBuilder.group(api, "ping", (handlers) =>
  handlers.handle("ping", () => Effect.succeed({ ok: true as const })),
);
const MetaLive = HttpApiBuilder.group(api, "meta", (handlers) =>
  handlers.handle("status", () => Effect.succeed({ up: true as const })),
);
const ByIpLive = HttpApiBuilder.group(api, "byIp", (handlers) =>
  handlers
    .handle("ip", () => Effect.succeed({ ok: true as const }))
    .handle("ipTrusted", () => Effect.succeed({ ok: true as const })),
);
let loginHandlerCalls = 0;
const LoginLive = HttpApiBuilder.group(api, "login", (handlers) =>
  handlers.handle("login", ({ payload }) => {
    loginHandlerCalls += 1;
    return payload.password === "correct horse"
      ? Effect.succeed({ token: `token-${payload.email}` })
      : Effect.fail(
          new UnauthorizedProblem({ error: "Unauthenticated", message: "bad credentials" }),
        );
  }),
);

let store: RateLimitStore;
let scope: Scope.CloseableScope | undefined;
let baseUrl = "";

const buildServer = async (customStore: RateLimitStore): Promise<void> => {
  const TestLive = serveTest.pipe(
    Layer.provide(
      HttpApiBuilder.api(api).pipe(
        Layer.provide([PingLive, MetaLive, ByIpLive, LoginLive, Health.layer(api)]),
      ),
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
          {
            label: "ip",
            rule: { points: 2, windowMillis: 10_000, blockMillis: 5_000 },
            match: (request) => request.url.startsWith("/ip-trusted"),
            key: (request) => clientIp(request, { trustProxy: true }),
          },
          {
            label: "ip-untrusted",
            rule: { points: 2, windowMillis: 10_000, blockMillis: 5_000 },
            match: (request) => request.url.startsWith("/ip"),
            key: (request) => clientIp(request, { trustProxy: false }),
          },
          {
            label: "login",
            rule: { points: 2, windowMillis: 60_000, blockMillis: 30_000 },
            match: (request) => request.method === "POST" && request.url.startsWith("/login"),
            keys: (request) =>
              request.json.pipe(
                Effect.map((body) => {
                  const email =
                    typeof body === "object" && body !== null && "email" in body
                      ? String((body as { email: unknown }).email)
                      : undefined;
                  const ip = request.headers["x-test-ip"] ?? "unknown";
                  return [`ip:${ip}`, email === undefined ? undefined : `email:${email}`];
                }),
                Effect.catchAll(() => Effect.succeed([])),
              ),
            consumeWhen: (response) => response.status === 401,
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

const postLogin = (
  ip: string,
  email: string,
  password: string,
  headers: Record<string, string> = {},
): Promise<Response> =>
  fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-ip": ip, ...headers },
    body: JSON.stringify({ email, password }),
  });

const QUOTA_HEADERS = [
  "ratelimit-limit",
  "ratelimit-remaining",
  "ratelimit-reset",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
] as const;

const quota = (response: Response): Record<(typeof QUOTA_HEADERS)[number], string | null> => ({
  "ratelimit-limit": response.headers.get("ratelimit-limit"),
  "ratelimit-remaining": response.headers.get("ratelimit-remaining"),
  "ratelimit-reset": response.headers.get("ratelimit-reset"),
  "x-ratelimit-limit": response.headers.get("x-ratelimit-limit"),
  "x-ratelimit-remaining": response.headers.get("x-ratelimit-remaining"),
  "x-ratelimit-reset": response.headers.get("x-ratelimit-reset"),
});

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

  test("counted responses carry the six quota headers; 429 carries Retry-After too", async () => {
    const user = `user-${crypto.randomUUID()}`;
    const first = await get("/ping", { "x-test-user": user });
    expect(quota(first)).toEqual({
      "ratelimit-limit": "3",
      "ratelimit-remaining": "2",
      "ratelimit-reset": "10",
      "x-ratelimit-limit": "3",
      "x-ratelimit-remaining": "2",
      "x-ratelimit-reset": "10",
    });
    expect(first.headers.get("retry-after")).toBeNull();
    await get("/ping", { "x-test-user": user });
    const third = await get("/ping", { "x-test-user": user });
    expect(third.headers.get("ratelimit-remaining")).toBe("0");
    expect(third.headers.get("x-ratelimit-remaining")).toBe("0");
    const denied = await get("/ping", { "x-test-user": user });
    expect(denied.status).toBe(429);
    expect(denied.headers.get("retry-after")).toBe("5");
    expect(quota(denied)).toEqual({
      "ratelimit-limit": "3",
      "ratelimit-remaining": "0",
      "ratelimit-reset": "10",
      "x-ratelimit-limit": "3",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": "10",
    });
  });

  test("uncounted responses carry no quota headers", async () => {
    const status = await get("/status");
    for (const name of QUOTA_HEADERS) expect(status.headers.get(name)).toBeNull();
    const probe = await get("/health/live");
    for (const name of QUOTA_HEADERS) expect(probe.headers.get(name)).toBeNull();
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

  test("spoofed x-forwarded-for without trustProxy keys by the socket address", async () => {
    // Every request comes from the same loopback socket: distinct spoofed hops
    // share one budget of 2.
    const first = await get("/ip", { "x-forwarded-for": `203.0.113.${1}` });
    expect(first.status).toBe(200);
    const second = await get("/ip", {
      "x-forwarded-for": "203.0.113.2",
      "x-real-ip": "198.51.100.9",
    });
    expect(second.status).toBe(200);
    const third = await get("/ip", { "x-forwarded-for": "203.0.113.3" });
    expect(third.status).toBe(429);
    const fourth = await get("/ip");
    expect(fourth.status).toBe(429);
  });

  test("with trustProxy the rightmost x-forwarded-for hop owns the budget", async () => {
    const proxyHop = `10.1.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    const otherHop = `10.2.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    // Varying the leftmost (client-controlled) hop does not open new budgets.
    expect(
      (await get("/ip-trusted", { "x-forwarded-for": `203.0.113.1, ${proxyHop}` })).status,
    ).toBe(200);
    expect(
      (await get("/ip-trusted", { "x-forwarded-for": `203.0.113.2, ${proxyHop}` })).status,
    ).toBe(200);
    expect(
      (await get("/ip-trusted", { "x-forwarded-for": `203.0.113.3, ${proxyHop}` })).status,
    ).toBe(429);
    // A different rightmost hop is a different budget.
    expect(
      (await get("/ip-trusted", { "x-forwarded-for": `203.0.113.3, ${otherHop}` })).status,
    ).toBe(200);
  });

  test("a consumeWhen group charges nothing on 200 and charges on 401", async () => {
    const ip = `ip-${crypto.randomUUID()}`;
    const email = `${crypto.randomUUID()}@example.com`;
    for (let index = 0; index < 4; index++) {
      const ok = await postLogin(ip, email, "correct horse");
      expect(ok.status).toBe(200);
      expect(ok.headers.get("ratelimit-remaining")).toBe("2");
      expect(ok.headers.get("ratelimit-limit")).toBe("2");
    }
    const refused = await postLogin(ip, email, "wrong");
    expect(refused.status).toBe(401);
    expect(refused.headers.get("ratelimit-remaining")).toBe("1");
    const refusedAgain = await postLogin(ip, email, "wrong");
    expect(refusedAgain.status).toBe(401);
    expect(refusedAgain.headers.get("ratelimit-remaining")).toBe("0");
  });

  test("a blocked key is refused before the handler runs", async () => {
    const ip = `ip-${crypto.randomUUID()}`;
    const email = `${crypto.randomUUID()}@example.com`;
    await postLogin(ip, email, "wrong");
    await postLogin(ip, email, "wrong");
    const callsBefore = loginHandlerCalls;
    const walled = await postLogin(ip, email, "correct horse");
    expect(walled.status).toBe(429);
    expect(walled.headers.get("retry-after")).toBe("60");
    expect(walled.headers.get("ratelimit-remaining")).toBe("0");
    expect(loginHandlerCalls).toBe(callsBefore);
  });

  test("several keys are charged together: ip and email each become walls", async () => {
    const attackerIp = `ip-${crypto.randomUUID()}`;
    const victim = `${crypto.randomUUID()}@example.com`;
    const other = `${crypto.randomUUID()}@example.com`;
    const otherIp = `ip-${crypto.randomUUID()}`;
    expect((await postLogin(attackerIp, victim, "wrong")).status).toBe(401);
    expect((await postLogin(attackerIp, victim, "wrong")).status).toBe(401);
    // The victim's email is walled, whoever asks.
    expect((await postLogin(otherIp, victim, "correct horse")).status).toBe(429);
    // The attacker's ip is walled, whichever email it names.
    expect((await postLogin(attackerIp, other, "correct horse")).status).toBe(429);
    // Unrelated ip + email pairs are untouched.
    expect((await postLogin(otherIp, other, "correct horse")).status).toBe(200);
  });
});
