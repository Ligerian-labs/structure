import { describe, expect, test } from "bun:test";
import { Effect, Redacted } from "effect";
import {
  type AuthEmail,
  type AuthRouteId,
  type AuthRouteViolation,
  allowAllRateLimiter,
  type InvalidAuthRoutes,
  inMemoryAuthStore,
  makeAuth,
  makeAuthHandler,
  type TenantAuthConfig,
} from "../src/index.js";

const config: TenantAuthConfig = {
  baseUrl: new URL("https://accounts.example.com"),
  oauth: {
    google: { clientId: "google-a", clientSecret: Redacted.make("google-s") },
  },
};

const emails: Array<AuthEmail> = [];
const auth = makeAuth({
  store: inMemoryAuthStore().store,
  resolveTenant: () => Effect.succeed(config),
  emailSender: { send: (email) => Effect.sync(() => emails.push(email)).pipe(Effect.asVoid) },
  rateLimiter: allowAllRateLimiter,
});

const handlerEffect = (routes: Partial<Record<AuthRouteId, string>>) =>
  makeAuthHandler(auth, {
    resolveTenant: () => Effect.succeed("tenant-a"),
    routes,
  });

const makeHandler = (routes: Partial<Record<AuthRouteId, string>>) =>
  Effect.runPromise(handlerEffect(routes));

const violationsOf = (routes: Partial<Record<AuthRouteId, string>>) =>
  Effect.runPromise(
    handlerEffect(routes).pipe(
      Effect.map((): ReadonlyArray<AuthRouteViolation> => []),
      Effect.catchAll((error: InvalidAuthRoutes) => Effect.succeed(error.violations)),
    ),
  );

const firstViolation = async (routes: Partial<Record<AuthRouteId, string>>) =>
  (await violationsOf(routes))[0];

const post = (path: string, body: unknown) =>
  new Request(`https://accounts.example.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://accounts.example.com" },
    body: JSON.stringify(body),
  });

const get = (path: string) => new Request(`https://accounts.example.com${path}`, { method: "GET" });

describe("auth route overrides", () => {
  test("serves an overridden route at its absolute path and 404s the default path", async () => {
    await Effect.runPromise(
      auth.registerPassword({
        tenantId: "tenant-a",
        email: "routes@example.com",
        password: "a long application-approved password",
      }),
    );
    const verification = emails.at(-1);
    if (verification === undefined) throw new Error("verification email missing");
    await Effect.runPromise(auth.verifyEmail("tenant-a", verification.token));

    const http = await makeHandler({ signInPassword: "/login" });

    const moved = await http.handler(
      post("/login", {
        email: "routes@example.com",
        password: "a long application-approved password",
      }),
    );
    expect(moved.status).toBe(200);
    expect(moved.headers.get("set-cookie")).toContain("session=");

    const old = await http.handler(
      post("/auth/sign-in/password", {
        email: "routes@example.com",
        password: "a long application-approved password",
      }),
    );
    expect(old.status).toBe(404);
  });

  test("keeps non-overridden routes at their basePath defaults", async () => {
    const http = await makeHandler({ signInPassword: "/login" });
    const kept = await http.handler(
      post("/auth/register/password", {
        email: "kept@example.com",
        password: "long enough application password",
      }),
    );
    expect(kept.status).toBe(201);
  });

  test("moves the GET session route outside the base path", async () => {
    const http = await makeHandler({ getSession: "/session" });
    const session = await http.handler(get("/session"));
    expect(session.status).toBe(200);
    expect(await session.json()).toEqual({ session: null });
    expect((await http.handler(get("/auth/session"))).status).toBe(404);
  });

  test("serves an overridden oauth start route with a :provider segment", async () => {
    const http = await makeHandler({ oauthStart: "/login/oauth/:provider/start" });
    const started = await http.handler(post("/login/oauth/google/start", {}));
    expect(started.status).toBe(200);
    const body = (await started.json()) as { authorizationUrl: string };
    expect(body.authorizationUrl).toContain("https://accounts.google.com");
  });

  test("rejects an override equal to its default as a legal no-op", async () => {
    const http = await makeHandler({ signOut: "/auth/sign-out" });
    expect((await http.handler(post("/auth/sign-out", {}))).status).toBe(200);
  });

  test("rejects paths without a leading slash, with a trailing slash, or without segments", async () => {
    expect((await firstViolation({ signInPassword: "login" as string }))?.route).toBe(
      "signInPassword",
    );
    expect((await firstViolation({ signOut: "/out/" }))?.route).toBe("signOut");
    expect((await firstViolation({ signOut: "/" }))?.route).toBe("signOut");
    expect((await firstViolation({ signOut: "" }))?.route).toBe("signOut");
  });

  test("rejects query strings, fragments, empty segments, and stray params", async () => {
    expect((await firstViolation({ signOut: "/a?b=c" }))?.reason).toContain("literal path");
    expect((await firstViolation({ signOut: "/a#f" }))?.reason).toContain("literal path");
    expect((await firstViolation({ signOut: "/a//b" }))?.reason).toContain("literal path");
    expect((await firstViolation({ signOut: "/out/:id" }))?.reason).toContain(":provider");
    expect((await firstViolation({ signOut: 42 as unknown as string }))?.reason).toContain(
      "string",
    );
  });

  test("requires exactly one :provider segment in oauth overrides and none elsewhere", async () => {
    expect((await firstViolation({ oauthStart: "/login/oauth/start" }))?.reason).toContain(
      ":provider",
    );
    expect(
      (await firstViolation({ oauthCallback: "/cb/:provider/x/:provider" }))?.reason,
    ).toContain(":provider");
    expect((await firstViolation({ signOut: "/out/:provider" }))?.reason).toContain(":provider");
  });

  test("rejects colliding overrides naming both routes", async () => {
    const failure = await firstViolation({ signInPassword: "/login", registerPassword: "/login" });
    expect(failure?.reason).toContain("signInPassword");
    expect(failure?.reason).toContain("registerPassword");
  });

  test("rejects an override colliding with a kept default route", async () => {
    const failure = await firstViolation({ signInPassword: "/auth/sign-out" });
    expect(failure?.reason).toContain("signOut");
  });

  test("rejects a literal override overlapping the oauth callback pattern", async () => {
    const failure = await firstViolation({ getSession: "/auth/oauth/google/callback" });
    expect(failure?.reason).toContain("oauthCallback");
  });

  test("rejects overlapping param and literal overrides sharing a method", async () => {
    const failure = await firstViolation({
      oauthStart: "/x/:provider/y",
      registerPassword: "/x/a/y",
    });
    expect(failure?.reason).toContain("oauthStart");
    expect(failure?.reason).toContain("registerPassword");
  });

  test("aggregates all violations including unknown route ids", async () => {
    const violations = await violationsOf({
      signInPassword: "login",
      signOut: "/x/",
      nope: "/y",
    } as Partial<Record<AuthRouteId, string>>);
    expect(violations.map((violation) => violation.route).sort()).toEqual([
      "nope",
      "signInPassword",
      "signOut",
    ]);
  });

  test("does not collide across different methods on the same path", async () => {
    expect(await violationsOf({ getSession: "/login", signInPassword: "/login" })).toEqual([]);
  });
});
