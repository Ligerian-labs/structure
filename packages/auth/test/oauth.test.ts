import { describe, expect, test } from "bun:test";
import { Effect, Redacted } from "effect";
import {
  AccountLinkDenied,
  AuthValidationError,
  allowAllRateLimiter,
  builtInOAuthProvider,
  InvalidAuthToken,
  inMemoryAuthStore,
  makeAuth,
  type OAuthHttpClient,
  RateLimitExceeded,
  type TenantAuthConfig,
} from "../src/index.js";

const credentials = (clientId: string) => ({
  clientId,
  clientSecret: Redacted.make(`${clientId}-secret`),
});

const config: TenantAuthConfig = {
  baseUrl: new URL("https://accounts.example.com"),
  oauth: {
    google: credentials("google-a"),
    github: credentials("github-a"),
    x: credentials("x-a"),
    linkedin: credentials("linkedin-a"),
  },
};

const fakeOAuth = (
  profile: unknown,
): {
  client: OAuthHttpClient;
  requests: Array<{
    readonly method: string;
    readonly url: string;
    readonly text: () => Promise<string>;
  }>;
} => {
  const requests: Array<{
    readonly method: string;
    readonly url: string;
    readonly text: () => Promise<string>;
  }> = [];
  return {
    requests,
    client: {
      execute: (request) =>
        Effect.sync(() => {
          requests.push({
            method: request.method,
            url: request.url,
            text: () => request.clone().text(),
          });
          if (request.method === "POST") {
            return Response.json({ access_token: "provider-access-token", token_type: "Bearer" });
          }
          return Response.json(profile);
        }),
    },
  };
};

const makeHarness = (profile: unknown, allowLink = false) => {
  const memory = inMemoryAuthStore();
  const oauth = fakeOAuth(profile);
  const auth = makeAuth({
    store: memory.store,
    resolveTenant: () => Effect.succeed(config),
    emailSender: { send: () => Effect.void },
    rateLimiter: allowAllRateLimiter,
    oauthHttpClient: oauth.client,
    ...(allowLink ? { accountLinkPolicy: { authorize: () => Effect.succeed(true) } } : {}),
  });
  return { auth, memory, oauth };
};

const stateFrom = (authorizationUrl: string): string =>
  new URL(authorizationUrl).searchParams.get("state") ?? "";

describe("OAuth providers", () => {
  test("defines Google, GitHub, X, and LinkedIn without provider SDKs", () => {
    const google = builtInOAuthProvider(config, "google");
    const github = builtInOAuthProvider(config, "github");
    const x = builtInOAuthProvider(config, "x");
    const linkedin = builtInOAuthProvider(config, "linkedin");

    expect(google?.authorizationEndpoint).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(github?.tokenEndpoint).toBe("https://github.com/login/oauth/access_token");
    expect(x?.authorizationEndpoint).toBe("https://twitter.com/i/oauth2/authorize");
    expect(linkedin?.scopes).toEqual(["openid", "profile", "email"]);
    expect(builtInOAuthProvider(config, "custom")).toBeUndefined();
  });

  test("uses tenant credentials and stores only hashed state with PKCE", async () => {
    const { auth, memory } = makeHarness({
      sub: "google-subject",
      email: "oauth@example.com",
      email_verified: true,
    });
    const started = await Effect.runPromise(auth.beginOAuth("tenant-a", "google", "/after-login"));
    const url = new URL(started.authorizationUrl);
    const rawState = stateFrom(started.authorizationUrl);

    expect(url.searchParams.get("client_id")).toBe("google-a");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")?.length).toBeGreaterThan(30);
    expect(memory.snapshot().oauthStates[0]?.stateHash).not.toBe(rawState);
    expect(JSON.stringify(memory.snapshot())).not.toContain(rawState);
  });

  test("completes authorization once, provisions a user, and creates a session", async () => {
    const { auth, memory, oauth } = makeHarness({
      sub: "google-subject",
      email: "OAuth@Example.com",
      email_verified: true,
      name: "OAuth User",
    });
    const started = await Effect.runPromise(auth.beginOAuth("tenant-a", "google"));
    const state = Redacted.make(stateFrom(started.authorizationUrl));
    const result = await Effect.runPromise(
      auth.completeOAuth({
        tenantId: "tenant-a",
        provider: "google",
        state,
        code: Redacted.make("authorization-code"),
      }),
    );

    expect(result.session.user.email).toBe("oauth@example.com");
    expect(result.session.user.emailVerified).toBe(true);
    expect(memory.snapshot().oauthIdentities).toHaveLength(1);
    expect(oauth.requests).toHaveLength(2);
    const tokenBody = await oauth.requests[0]?.text();
    expect(tokenBody).toContain("code_verifier=");
    expect(tokenBody).toContain("client_secret=google-a-secret");
    expect(
      await Effect.runPromise(
        Effect.flip(
          auth.completeOAuth({
            tenantId: "tenant-a",
            provider: "google",
            state,
            code: Redacted.make("authorization-code"),
          }),
        ),
      ),
    ).toBeInstanceOf(InvalidAuthToken);
  });

  test("carries bounded application flow context across the callback exactly once", async () => {
    const { auth } = makeHarness({
      sub: "google-subject",
      email: "oauth@example.com",
      email_verified: true,
    });
    const flowContext = { intent: "sign-up", analyticsConsent: true, distinctId: "anon-42" };
    const started = await Effect.runPromise(auth.beginOAuth("tenant-a", "google", { flowContext }));
    // application context never rides the authorization URL
    expect(started.authorizationUrl).not.toContain("analyticsConsent");

    const state = Redacted.make(stateFrom(started.authorizationUrl));
    const result = await Effect.runPromise(
      auth.completeOAuth({
        tenantId: "tenant-a",
        provider: "google",
        state,
        code: Redacted.make("authorization-code"),
      }),
    );
    expect(result.flowContext).toEqual(flowContext);

    // consumed with the state: a replay returns neither session nor context
    expect(
      await Effect.runPromise(
        Effect.flip(
          auth.completeOAuth({
            tenantId: "tenant-a",
            provider: "google",
            state,
            code: Redacted.make("authorization-code"),
          }),
        ),
      ),
    ).toBeInstanceOf(InvalidAuthToken);
  });

  test("provider mismatch does not consume another provider's state", async () => {
    const { auth } = makeHarness({
      sub: "google-subject",
      email: "oauth@example.com",
      email_verified: true,
    });
    const started = await Effect.runPromise(
      auth.beginOAuth("tenant-a", "google", { flowContext: { intent: "sign-up" } }),
    );
    const state = Redacted.make(stateFrom(started.authorizationUrl));
    // A callback routed to the wrong provider fails...
    expect(
      await Effect.runPromise(
        Effect.flip(
          auth.completeOAuth({
            tenantId: "tenant-a",
            provider: "github",
            state,
            code: Redacted.make("authorization-code"),
          }),
        ),
      ),
    ).toBeInstanceOf(InvalidAuthToken);
    // ...without burning the state: the correct provider callback still works
    // and receives the flow context exactly once.
    const result = await Effect.runPromise(
      auth.completeOAuth({
        tenantId: "tenant-a",
        provider: "google",
        state,
        code: Redacted.make("authorization-code"),
      }),
    );
    expect(result.flowContext).toEqual({ intent: "sign-up" });
  });

  test("rejects oversized flow context before persisting any state", async () => {
    const { auth, memory } = makeHarness({
      sub: "google-subject",
      email: "oauth@example.com",
      email_verified: true,
    });
    const oversized: Record<string, string> = {};
    for (let index = 0; index < 40; index += 1) oversized[`key-${index}`] = "x".repeat(100);
    const error = await Effect.runPromise(
      Effect.flip(
        auth.beginOAuth("tenant-a", "google", {
          flowContext: oversized as Record<string, string>,
        }),
      ),
    );
    expect(error).toBeInstanceOf(AuthValidationError);
    expect(memory.snapshot().oauthStates).toHaveLength(0);
  });

  test("rejects flow context values that are not JSON primitives", async () => {
    const { auth, memory } = makeHarness({
      sub: "google-subject",
      email: "oauth@example.com",
      email_verified: true,
    });
    const nested = { nested: { deep: true } } as unknown as Record<string, string>;
    const error = await Effect.runPromise(
      Effect.flip(auth.beginOAuth("tenant-a", "google", { flowContext: nested })),
    );
    expect(error).toBeInstanceOf(AuthValidationError);
    expect(memory.snapshot().oauthStates).toHaveLength(0);
  });

  test("does not link a verified matching email unless policy explicitly allows it", async () => {
    const memory = inMemoryAuthStore();
    const now = new Date("2026-08-20T12:00:00.000Z");
    await Effect.runPromise(
      memory.store.createMagicLinkUser({
        id: "existing-user",
        tenantId: "tenant-a",
        email: "same@example.com",
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      }),
    );
    const oauth = fakeOAuth({
      sub: "provider-subject",
      email: "same@example.com",
      email_verified: true,
    });
    const baseOptions = {
      store: memory.store,
      resolveTenant: () => Effect.succeed(config),
      emailSender: { send: () => Effect.void },
      rateLimiter: allowAllRateLimiter,
      oauthHttpClient: oauth.client,
    };
    const denied = makeAuth(baseOptions);
    const deniedStart = await Effect.runPromise(denied.beginOAuth("tenant-a", "google"));
    const error = await Effect.runPromise(
      Effect.flip(
        denied.completeOAuth({
          tenantId: "tenant-a",
          provider: "google",
          state: Redacted.make(stateFrom(deniedStart.authorizationUrl)),
          code: Redacted.make("code"),
        }),
      ),
    );
    expect(error).toBeInstanceOf(AccountLinkDenied);
    expect(memory.snapshot().oauthIdentities).toHaveLength(0);

    const allowed = makeAuth({
      ...baseOptions,
      accountLinkPolicy: { authorize: () => Effect.succeed(true) },
    });
    const allowedStart = await Effect.runPromise(allowed.beginOAuth("tenant-a", "google"));
    const linked = await Effect.runPromise(
      allowed.completeOAuth({
        tenantId: "tenant-a",
        provider: "google",
        state: Redacted.make(stateFrom(allowedStart.authorizationUrl)),
        code: Redacted.make("code"),
      }),
    );
    expect(linked.session.user.id).toBe("existing-user");
    expect(memory.snapshot().oauthIdentities).toHaveLength(1);
  });

  test("uses GitHub's verified-email response even when the profile has a public email", async () => {
    const memory = inMemoryAuthStore();
    const requests: Array<string> = [];
    const auth = makeAuth({
      store: memory.store,
      resolveTenant: () => Effect.succeed(config),
      emailSender: { send: () => Effect.void },
      rateLimiter: allowAllRateLimiter,
      oauthHttpClient: {
        execute: (request) =>
          Effect.sync(() => {
            requests.push(request.url);
            if (request.method === "POST") {
              return Response.json({ access_token: "provider-access-token" });
            }
            if (request.url.endsWith("/user/emails")) {
              return Response.json([
                { email: "Verified@Example.com", primary: true, verified: true },
              ]);
            }
            return Response.json({
              id: 123,
              email: "public@example.com",
              name: "GitHub User",
            });
          }),
      },
    });
    const started = await Effect.runPromise(auth.beginOAuth("tenant-a", "github"));
    const completed = await Effect.runPromise(
      auth.completeOAuth({
        tenantId: "tenant-a",
        provider: "github",
        state: Redacted.make(stateFrom(started.authorizationUrl)),
        code: Redacted.make("code"),
      }),
    );

    expect(completed.session.user.email).toBe("verified@example.com");
    expect(completed.session.user.emailVerified).toBe(true);
    expect(requests.some((url) => url.endsWith("/user/emails"))).toBe(true);
  });

  test("supports X identities without claiming an email address", async () => {
    const { auth } = makeHarness({ data: { id: "x-subject", name: "X User", username: "x" } });
    const started = await Effect.runPromise(auth.beginOAuth("tenant-a", "x"));
    const completed = await Effect.runPromise(
      auth.completeOAuth({
        tenantId: "tenant-a",
        provider: "x",
        state: Redacted.make(stateFrom(started.authorizationUrl)),
        code: Redacted.make("code"),
      }),
    );
    expect(completed.session.user.email).toBeUndefined();
    expect(completed.session.user.emailVerified).toBe(false);
  });
});

describe("external sign-in start wall", () => {
  test("is keyed on the caller, so one caller cannot exhaust a provider for everyone", async () => {
    const counts = new Map<string, number>();
    const memory = inMemoryAuthStore();
    const auth = makeAuth({
      store: memory.store,
      resolveTenant: () => Effect.succeed(config),
      emailSender: { send: () => Effect.void },
      rateLimiter: {
        check: (request) =>
          Effect.suspend(() => {
            const key = `${request.action}:${request.keyHash}`;
            const seen = (counts.get(key) ?? 0) + 1;
            counts.set(key, seen);
            return seen > 60
              ? Effect.fail(new RateLimitExceeded({ action: request.action }))
              : Effect.void;
          }),
      },
    });
    for (let index = 0; index < 60; index++) {
      await Effect.runPromise(
        auth.beginOAuth("tenant-a", "google", undefined, { subject: "203.0.113.7" }),
      );
    }
    const refused = await Effect.runPromise(
      Effect.flip(auth.beginOAuth("tenant-a", "google", undefined, { subject: "203.0.113.7" })),
    );
    expect(refused).toBeInstanceOf(RateLimitExceeded);
    const other = await Effect.runPromise(
      auth.beginOAuth("tenant-a", "google", undefined, { subject: "198.51.100.9" }),
    );
    expect(other.authorizationUrl).toContain("accounts.google.com");
    const keys = [...counts.keys()].filter((key) => key.startsWith("oauth-start:"));
    expect(keys).toHaveLength(2);
    expect(JSON.stringify(keys)).not.toContain("203.0.113.7");
    // Without a caller subject there is no shared bucket to exhaust.
    for (let index = 0; index < 70; index++) {
      await Effect.runPromise(auth.beginOAuth("tenant-a", "google"));
    }
    expect([...counts.keys()].filter((key) => key.startsWith("oauth-start:"))).toHaveLength(2);
  });
});
