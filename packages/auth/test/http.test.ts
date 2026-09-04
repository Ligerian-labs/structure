import { describe, expect, test } from "bun:test";
import { Effect, Redacted } from "effect";
import {
  type AuthEmail,
  AuthValidationError,
  allowAllRateLimiter,
  inMemoryAuthStore,
  makeAuth,
  makeAuthHandler,
  type TenantAuthConfig,
} from "../src/index.js";

const config: TenantAuthConfig = {
  baseUrl: new URL("https://accounts.example.com"),
  session: { cookieName: "tenant_session" },
  passkey: {
    rpId: "accounts.example.com",
    rpName: "Example",
    origins: ["https://accounts.example.com"],
  },
};

const request = (
  path: string,
  body: unknown,
  options: { readonly tenant?: string; readonly origin?: string; readonly cookie?: string } = {},
) =>
  new Request(`https://accounts.example.com${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: options.origin ?? "https://accounts.example.com",
      "x-tenant": options.tenant ?? "tenant-a",
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
    },
    body: JSON.stringify(body),
  });

describe("auth HTTP handler", () => {
  test("resolves the tenant outside the body and manages the magic-link session cookie", async () => {
    const emails: Array<AuthEmail> = [];
    const memory = inMemoryAuthStore();
    const auth = makeAuth({
      store: memory.store,
      resolveTenant: () => Effect.succeed(config),
      emailSender: { send: (email) => Effect.sync(() => emails.push(email)).pipe(Effect.asVoid) },
      rateLimiter: allowAllRateLimiter,
    });
    const http = await Effect.runPromise(
      makeAuthHandler(auth, {
        resolveTenant: (incoming) => {
          const tenant = incoming.headers.get("x-tenant");
          return tenant === null
            ? Effect.fail(
                new AuthValidationError({ field: "tenant", reason: "header is required" }),
              )
            : Effect.succeed(tenant);
        },
      }),
    );

    const requested = await http.handler(
      request("/auth/magic-link/request", {
        tenantId: "attacker-controlled",
        email: "http@example.com",
      }),
    );
    expect(requested.status).toBe(202);
    expect(emails[0]?.tenantId).toBe("tenant-a");
    const delivery = emails[0];
    if (delivery === undefined) throw new Error("magic-link email was not captured");

    const consumed = await http.handler(
      request("/auth/magic-link/consume", { token: Redacted.value(delivery.token) }),
    );
    expect(consumed.status).toBe(200);
    const cookie = consumed.headers.get("set-cookie");
    expect(cookie).toContain("tenant_session=");
    expect(cookie).toContain("HttpOnly; SameSite=Lax; Secure");
    const cookieValue = cookie?.split(";")[0] ?? "";

    const session = await http.handler(
      new Request("https://accounts.example.com/auth/session", {
        headers: { "x-tenant": "tenant-a", cookie: cookieValue },
      }),
    );
    expect(session.status).toBe(200);
    expect(await session.json()).toEqual(
      expect.objectContaining({
        session: expect.objectContaining({
          user: expect.objectContaining({ email: "http@example.com" }),
        }),
      }),
    );

    const wrongTenant = await http.handler(
      new Request("https://accounts.example.com/auth/session", {
        headers: { "x-tenant": "tenant-b", cookie: cookieValue },
      }),
    );
    expect(wrongTenant.status).toBe(401);

    const signedOut = await http.handler(request("/auth/sign-out", {}, { cookie: cookieValue }));
    expect(signedOut.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  test("rejects cross-origin mutations and malformed passkey bodies safely", async () => {
    const memory = inMemoryAuthStore();
    const auth = makeAuth({
      store: memory.store,
      resolveTenant: () => Effect.succeed(config),
      emailSender: { send: () => Effect.void },
      rateLimiter: allowAllRateLimiter,
    });
    const http = await Effect.runPromise(
      makeAuthHandler(auth, {
        resolveTenant: () => Effect.succeed("tenant-a"),
      }),
    );

    const crossOrigin = await http.handler(
      request(
        "/auth/magic-link/request",
        { email: "victim@example.com" },
        { origin: "https://evil.example.com" },
      ),
    );
    expect(crossOrigin.status).toBe(400);

    const malformed = await http.handler(
      request("/auth/passkeys/authenticate/verify", { credentialId: "missing-response" }),
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual(
      expect.objectContaining({ error: "AuthValidationError" }),
    );

    const oversized = await http.handler(
      request("/auth/magic-link/request", { email: `${"x".repeat(70_000)}@example.com` }),
    );
    expect(oversized.status).toBe(400);
  });

  test("returns 401 when a pending second-factor session attempts passkey registration", async () => {
    const memory = inMemoryAuthStore();
    const emails: Array<AuthEmail> = [];
    const auth = makeAuth({
      store: memory.store,
      resolveTenant: () => Effect.succeed(config),
      emailSender: { send: (email) => Effect.sync(() => emails.push(email)).pipe(Effect.asVoid) },
      rateLimiter: allowAllRateLimiter,
      secondFactor: { isEnrolled: () => Effect.succeed(true) },
    });
    const http = await Effect.runPromise(
      makeAuthHandler(auth, { resolveTenant: () => Effect.succeed("tenant-a") }),
    );
    await http.handler(request("/auth/magic-link/request", { email: "pending@example.com" }));
    const magicLink = emails[0];
    if (magicLink === undefined) throw new Error("magic-link email was not captured");
    const consumed = await http.handler(
      request("/auth/magic-link/consume", { token: Redacted.value(magicLink.token) }),
    );
    const cookie = consumed.headers.get("set-cookie")?.split(";")[0] ?? "";

    const response = await http.handler(request("/auth/passkeys/register/options", {}, { cookie }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(
      expect.objectContaining({ error: "SecondFactorRequired" }),
    );
  });
});
