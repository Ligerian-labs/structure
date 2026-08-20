import { describe, expect, test } from "bun:test";
import { Effect, Redacted } from "effect";
import {
  AccountLinkDenied,
  allowAllRateLimiter,
  builtInOAuthProvider,
  InvalidAuthToken,
  inMemoryAuthStore,
  makeAuth,
  type OAuthHttpClient,
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
