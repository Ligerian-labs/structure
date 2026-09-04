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
  oauthHttpClient: {
    execute: (request) =>
      Effect.succeed(
        request.method === "POST"
          ? Response.json({ access_token: "provider-access-token", token_type: "Bearer" })
          : Response.json({
              sub: "route-test-subject",
              email: "route-oauth@example.com",
              email_verified: true,
            }),
      ),
  },
});

const handlerEffect = (
  routes: Partial<Record<AuthRouteId, string>>,
  options: { readonly basePath?: string; readonly oauthCallbackRedirect?: string } = {},
) =>
  makeAuthHandler(auth, {
    resolveTenant: () => Effect.succeed("tenant-a"),
    routes,
    ...(options.basePath === undefined ? {} : { basePath: options.basePath }),
    ...(options.oauthCallbackRedirect === undefined
      ? {}
      : { oauthCallbackRedirect: options.oauthCallbackRedirect }),
  });

const makeHandler = (
  routes: Partial<Record<AuthRouteId, string>>,
  options?: { readonly basePath?: string; readonly oauthCallbackRedirect?: string },
) => Effect.runPromise(handlerEffect(routes, options));

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
    const http = await makeHandler({
      oauthStart: "/login/oauth/:provider/start",
      oauthCallback: "/login/oauth/:provider/finish",
    });
    const started = await http.handler(post("/login/oauth/google/start", {}));
    expect(started.status).toBe(200);
    const body = (await started.json()) as { authorizationUrl: string };
    expect(body.authorizationUrl).toContain("https://accounts.google.com");
    expect(new URL(body.authorizationUrl).searchParams.get("redirect_uri")).toBe(
      "https://accounts.example.com/login/oauth/google/finish",
    );
    expect(await Effect.runPromise(http.authorizationServerRedirectUri("tenant-a", "google"))).toBe(
      "https://accounts.example.com/login/oauth/google/finish",
    );
  });

  test("derives the provider redirect URI from basePath", async () => {
    const http = await makeHandler({}, { basePath: "/api/v1/auth" });
    const started = await http.handler(post("/api/v1/auth/oauth/google/start", {}));
    const body = (await started.json()) as { authorizationUrl: string };
    expect(new URL(body.authorizationUrl).searchParams.get("redirect_uri")).toBe(
      "https://accounts.example.com/api/v1/auth/oauth/google/callback",
    );
  });

  test("redirects browser callbacks to the validated return URL when configured", async () => {
    const http = await makeHandler({}, { oauthCallbackRedirect: "/signed-in" });
    const started = await http.handler(
      post("/auth/oauth/google/start", { returnTo: "/dashboard" }),
    );
    const body = (await started.json()) as { authorizationUrl: string };
    const state = new URL(body.authorizationUrl).searchParams.get("state") ?? "";
    const callback = await http.handler(
      get(`/auth/oauth/google/callback?state=${encodeURIComponent(state)}&code=provider-code`),
    );

    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe("https://accounts.example.com/dashboard");
    expect(callback.headers.get("set-cookie")).toContain("structure_session=");
    expect(callback.headers.get("cache-control")).toBe("no-store");

    const fallbackStart = await http.handler(post("/auth/oauth/google/start", {}));
    const fallbackBody = (await fallbackStart.json()) as { authorizationUrl: string };
    const fallbackState = new URL(fallbackBody.authorizationUrl).searchParams.get("state") ?? "";
    const fallbackCallback = await http.handler(
      get(
        `/auth/oauth/google/callback?state=${encodeURIComponent(fallbackState)}&code=provider-code`,
      ),
    );
    expect(fallbackCallback.status).toBe(303);
    expect(fallbackCallback.headers.get("location")).toBe("https://accounts.example.com/signed-in");
  });

  test("keeps the OAuth callback JSON response when no redirect is configured", async () => {
    const http = await makeHandler({});
    const started = await http.handler(post("/auth/oauth/google/start", {}));
    const body = (await started.json()) as { authorizationUrl: string };
    const state = new URL(body.authorizationUrl).searchParams.get("state") ?? "";
    const callback = await http.handler(
      get(`/auth/oauth/google/callback?state=${encodeURIComponent(state)}&code=provider-code`),
    );

    expect(callback.status).toBe(200);
    expect(callback.headers.get("content-type")).toContain("application/json");
    expect(await callback.json()).toEqual(
      expect.objectContaining({
        user: expect.objectContaining({ email: "route-oauth@example.com" }),
      }),
    );
  });

  test("rejects an OAuth callback redirect outside the application origin", async () => {
    const violations = await Effect.runPromise(
      handlerEffect({}, { oauthCallbackRedirect: "//evil.example.com/signed-in" }).pipe(
        Effect.map((): ReadonlyArray<AuthRouteViolation> => []),
        Effect.catchAll((error: InvalidAuthRoutes) => Effect.succeed(error.violations)),
      ),
    );
    expect(violations).toEqual([
      expect.objectContaining({
        route: "oauthCallbackRedirect",
        reason: expect.stringContaining("application path"),
      }),
    ]);
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
