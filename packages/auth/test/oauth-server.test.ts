import { describe, expect, test } from "bun:test";
import { Policy } from "@structure-ai/authorization";
import { Effect, Redacted } from "effect";
import {
  type AuthorizationServer,
  AuthValidationError,
  generateSigningKey,
  InvalidAuthToken,
  InvalidCredentials,
  inMemoryOAuthServerStore,
  makeAuthorizationServer,
  type OAuthSigningKeys,
} from "../src/index.js";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);
const flip = <A, E>(effect: Effect.Effect<A, E>): Promise<E> => run(Effect.flip(effect));

const clock = { value: new Date("2026-08-20T12:00:00.000Z") };
const advance = (millis: number): void => {
  clock.value = new Date(clock.value.getTime() + millis);
};

const buildServer = async (registration?: {
  anonymous?: boolean;
  signedIn?: boolean;
}): Promise<{
  server: AuthorizationServer;
  store: ReturnType<typeof inMemoryOAuthServerStore>;
  keys: OAuthSigningKeys;
}> => {
  const store = inMemoryOAuthServerStore();
  const key = await run(generateSigningKey());
  const server = makeAuthorizationServer({
    store,
    resolveTenant: (tenantId) =>
      Effect.succeed({ baseUrl: new URL(`https://${tenantId}.example.com`) }),
    signingKeys: { current: key },
    ...(registration === undefined ? {} : { registration }),
    codeTtlMillis: 60_000,
    accessTokenTtlMillis: 10 * 60_000,
    refreshTokenTtlMillis: 30 * 24 * 60 * 60_000,
    endSessionHintTtlMillis: 5 * 60_000,
    primitives: { now: () => clock.value },
  });
  return { server, store, keys: { current: key } };
};

const pkce = async (): Promise<{ verifier: string; challenge: string }> => {
  const verifier = "a".repeat(64);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = Buffer.from(digest).toString("base64url");
  return { verifier, challenge };
};

const registerClient = async (server: AuthorizationServer) => {
  const minted = await run(
    server.registerClient(
      "tenant-a",
      {
        clientName: "Agent CLI",
        clientType: "confidential",
        redirectUris: ["https://agent.example.com/callback"],
        scopes: ["mcp:tools", "data:export"],
      },
      { kind: "signed-in", userId: "user-1" },
    ),
  );
  expect(minted.clientSecret).toBeDefined();
  return minted;
};

describe("client registration", () => {
  test("is closed by default on both paths and opens only via settings", async () => {
    const closed = await buildServer();
    const anonymous = await flip(
      closed.server.registerClient(
        "tenant-a",
        { clientType: "public", redirectUris: ["https://a.example.com/cb"], scopes: ["mcp:tools"] },
        { kind: "anonymous" },
      ),
    );
    expect(anonymous).toBeInstanceOf(AuthValidationError);
    const signedIn = await flip(
      closed.server.registerClient(
        "tenant-a",
        { clientType: "public", redirectUris: ["https://a.example.com/cb"], scopes: ["mcp:tools"] },
        { kind: "signed-in", userId: "user-1" },
      ),
    );
    expect(signedIn).toBeInstanceOf(AuthValidationError);

    const open = await buildServer({ anonymous: true, signedIn: true });
    const minted = await registerClient(open.server);
    expect(minted.record.clientId).toMatch(/^as_/u);
    expect(minted.record.secretHash).toBeDefined();
    // The raw secret never appears at rest.
    expect(JSON.stringify(open.store.snapshot().clients)).not.toContain(
      Redacted.value(minted.clientSecret ?? Redacted.make("")),
    );
  });
});

describe("authorization code + PKCE", () => {
  test("happy path: consent, code, verifier, tokens", async () => {
    const { server } = await buildServer({ signedIn: true });
    const minted = await registerClient(server);
    const secret = minted.clientSecret ?? Redacted.make("");
    const { verifier, challenge } = await pkce();

    const request = {
      tenantId: "tenant-a",
      clientId: minted.record.clientId,
      redirectUri: "https://agent.example.com/callback",
      scope: ["mcp:tools"],
      state: "st-1",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    };
    // Stale consent: nothing granted yet → consent required.
    const needsConsent = await run(server.authorize(request, "user-1"));
    expect(needsConsent).toMatchObject({ consentRequired: true, state: "st-1" });

    await run(
      server.grantConsent({
        tenantId: "tenant-a",
        userId: "user-1",
        clientId: minted.record.clientId,
        scope: ["mcp:tools"],
      }),
    );
    const decision = await run(server.authorize(request, "user-1"));
    if (!("redirectUrl" in decision)) throw new Error("expected redirect");
    const url = new URL(decision.redirectUrl);
    expect(url.origin + url.pathname).toBe("https://agent.example.com/callback");
    expect(url.searchParams.get("state")).toBe("st-1");
    const code = url.searchParams.get("code") ?? "";

    const tokens = await run(
      server.exchangeCode({
        tenantId: "tenant-a",
        clientId: minted.record.clientId,
        clientSecret: secret,
        code: Redacted.make(code),
        codeVerifier: verifier,
        redirectUri: "https://agent.example.com/callback",
      }),
    );
    expect(tokens.tokenType).toBe("Bearer");
    expect(tokens.refreshToken).toBeDefined();
    const claims = await run(
      server.verifyAccessToken("tenant-a", Redacted.make(tokens.accessToken)),
    );
    expect(claims.sub).toBe("user-1");
    expect(claims.scope).toBe("mcp:tools");

    // Replayed code: single-use.
    const replay = await flip(
      server.exchangeCode({
        tenantId: "tenant-a",
        clientId: minted.record.clientId,
        clientSecret: secret,
        code: Redacted.make(code),
        codeVerifier: verifier,
        redirectUri: "https://agent.example.com/callback",
      }),
    );
    expect(replay).toBeInstanceOf(InvalidAuthToken);

    // Stale consent again: a wider scope than granted requires fresh consent.
    const wider = await run(
      server.authorize({ ...request, scope: ["mcp:tools", "data:export"] }, "user-1"),
    );
    expect(wider).toMatchObject({ consentRequired: true });
  });

  test("wrong verifier fails; plain PKCE refused; unknown clients and redirects fail closed", async () => {
    const { server } = await buildServer({ signedIn: true });
    const minted = await registerClient(server);
    const secret = minted.clientSecret ?? Redacted.make("");
    const { verifier, challenge } = await pkce();
    await run(
      server.grantConsent({
        tenantId: "tenant-a",
        userId: "user-1",
        clientId: minted.record.clientId,
        scope: ["mcp:tools"],
      }),
    );
    const decision = await run(
      server.authorize(
        {
          tenantId: "tenant-a",
          clientId: minted.record.clientId,
          redirectUri: "https://agent.example.com/callback",
          scope: ["mcp:tools"],
          codeChallenge: challenge,
          codeChallengeMethod: "S256",
        },
        "user-1",
      ),
    );
    if (!("redirectUrl" in decision)) throw new Error("expected redirect");
    const code = new URL(decision.redirectUrl).searchParams.get("code") ?? "";

    const wrong = await flip(
      server.exchangeCode({
        tenantId: "tenant-a",
        clientId: minted.record.clientId,
        clientSecret: secret,
        code: Redacted.make(code),
        codeVerifier: `${verifier}x`,
        redirectUri: "https://agent.example.com/callback",
      }),
    );
    expect(wrong).toBeInstanceOf(InvalidCredentials);

    const plain = await flip(
      server.authorize(
        {
          tenantId: "tenant-a",
          clientId: minted.record.clientId,
          redirectUri: "https://agent.example.com/callback",
          scope: ["mcp:tools"],
          codeChallenge: challenge,
          codeChallengeMethod: "plain",
        },
        "user-1",
      ),
    );
    expect(plain).toBeInstanceOf(AuthValidationError);

    const unknownClient = await flip(
      server.authorize(
        {
          tenantId: "tenant-a",
          clientId: "as_unknown",
          redirectUri: "https://agent.example.com/callback",
          scope: ["mcp:tools"],
          codeChallenge: challenge,
          codeChallengeMethod: "S256",
        },
        "user-1",
      ),
    );
    expect(unknownClient).toBeInstanceOf(AuthValidationError);

    const badRedirect = await flip(
      server.authorize(
        {
          tenantId: "tenant-a",
          clientId: minted.record.clientId,
          redirectUri: "https://evil.example.com/callback",
          scope: ["mcp:tools"],
          codeChallenge: challenge,
          codeChallengeMethod: "S256",
        },
        "user-1",
      ),
    );
    expect(badRedirect).toBeInstanceOf(AuthValidationError);
  });
});

describe("refresh, revocation, introspection", () => {
  test("refresh rotates; replays fail; revocation and introspection agree", async () => {
    const { server } = await buildServer({ signedIn: true });
    const minted = await registerClient(server);
    const secret = minted.clientSecret ?? Redacted.make("");
    const { verifier, challenge } = await pkce();
    await run(
      server.grantConsent({
        tenantId: "tenant-a",
        userId: "user-1",
        clientId: minted.record.clientId,
        scope: ["mcp:tools"],
      }),
    );
    const decision = await run(
      server.authorize(
        {
          tenantId: "tenant-a",
          clientId: minted.record.clientId,
          redirectUri: "https://agent.example.com/callback",
          scope: ["mcp:tools"],
          codeChallenge: challenge,
          codeChallengeMethod: "S256",
        },
        "user-1",
      ),
    );
    if (!("redirectUrl" in decision)) throw new Error("expected redirect");
    const code = new URL(decision.redirectUrl).searchParams.get("code") ?? "";
    const first = await run(
      server.exchangeCode({
        tenantId: "tenant-a",
        clientId: minted.record.clientId,
        clientSecret: secret,
        code: Redacted.make(code),
        codeVerifier: verifier,
        redirectUri: "https://agent.example.com/callback",
      }),
    );
    const refreshToken = first.refreshToken ?? "";

    const rotated = await run(
      server.refresh({
        tenantId: "tenant-a",
        clientId: minted.record.clientId,
        clientSecret: secret,
        refreshToken: Redacted.make(refreshToken),
      }),
    );
    expect(rotated.refreshToken).toBeDefined();
    expect(rotated.refreshToken).not.toBe(refreshToken);

    // Replaying the rotated-away token fails.
    const replay = await flip(
      server.refresh({
        tenantId: "tenant-a",
        clientId: minted.record.clientId,
        clientSecret: secret,
        refreshToken: Redacted.make(refreshToken),
      }),
    );
    expect(replay).toBeInstanceOf(InvalidAuthToken);

    // Introspection: active before revocation.
    const before = await run(
      server.introspect({
        tenantId: "tenant-a",
        clientId: minted.record.clientId,
        clientSecret: secret,
        token: Redacted.make(first.accessToken),
      }),
    );
    expect(before.active).toBe(true);
    expect(before.scope).toBe("mcp:tools");

    // RFC 7009: revocation answers success, is idempotent.
    await run(
      server.revoke({
        tenantId: "tenant-a",
        clientId: minted.record.clientId,
        clientSecret: secret,
        token: Redacted.make(first.accessToken),
      }),
    );
    await run(
      server.revoke({
        tenantId: "tenant-a",
        clientId: minted.record.clientId,
        clientSecret: secret,
        token: Redacted.make(first.accessToken),
      }),
    );
    const after = await run(
      server.introspect({
        tenantId: "tenant-a",
        clientId: minted.record.clientId,
        clientSecret: secret,
        token: Redacted.make(first.accessToken),
      }),
    );
    expect(after.active).toBe(false);
    // A revoked access token no longer verifies.
    const verifyError = await flip(
      server.verifyAccessToken("tenant-a", Redacted.make(first.accessToken)),
    );
    expect(verifyError).toBeInstanceOf(InvalidAuthToken);
  });
});

describe("JWKS rotation", () => {
  test("rotating the signing key keeps outstanding tokens valid", async () => {
    const store = inMemoryOAuthServerStore();
    const keyA = await run(generateSigningKey());
    let server = makeAuthorizationServer({
      store,
      resolveTenant: (tenantId) =>
        Effect.succeed({ baseUrl: new URL(`https://${tenantId}.example.com`) }),
      signingKeys: { current: keyA },
      registration: { signedIn: true },
      primitives: { now: () => clock.value },
    });
    const minted = await run(
      server.registerClient(
        "tenant-a",
        {
          clientType: "public",
          redirectUris: ["https://agent.example.com/callback"],
          scopes: ["mcp:tools"],
        },
        { kind: "signed-in", userId: "user-1" },
      ),
    );
    const { verifier, challenge } = await pkce();
    await run(
      server.grantConsent({
        tenantId: "tenant-a",
        userId: "user-1",
        clientId: minted.record.clientId,
        scope: ["mcp:tools"],
      }),
    );
    const issue = async (): Promise<string> => {
      const decision = await run(
        server.authorize(
          {
            tenantId: "tenant-a",
            clientId: minted.record.clientId,
            redirectUri: "https://agent.example.com/callback",
            scope: ["mcp:tools"],
            codeChallenge: challenge,
            codeChallengeMethod: "S256",
          },
          "user-1",
        ),
      );
      if (!("redirectUrl" in decision)) throw new Error("expected redirect");
      const code = new URL(decision.redirectUrl).searchParams.get("code") ?? "";
      const tokens = await run(
        server.exchangeCode({
          tenantId: "tenant-a",
          clientId: minted.record.clientId,
          code: Redacted.make(code),
          codeVerifier: verifier,
          redirectUri: "https://agent.example.com/callback",
        }),
      );
      return tokens.accessToken;
    };
    const oldToken = await issue();

    // Rotate: B becomes current, A stays as previous.
    const keyB = await run(generateSigningKey());
    server = makeAuthorizationServer({
      store,
      resolveTenant: (tenantId) =>
        Effect.succeed({ baseUrl: new URL(`https://${tenantId}.example.com`) }),
      signingKeys: { current: keyB, previous: keyA },
      registration: { signedIn: true },
      primitives: { now: () => clock.value },
    });
    const jwks = server.jwks();
    expect(jwks.keys).toHaveLength(2);
    // Outstanding token from key A still verifies...
    const claims = await run(server.verifyAccessToken("tenant-a", Redacted.make(oldToken)));
    expect(claims.sub).toBe("user-1");
    // ...and new tokens are signed by key B.
    const newToken = await issue();
    const header = JSON.parse(
      Buffer.from(newToken.split(".")[0] ?? "", "base64url").toString("utf8"),
    ) as { kid?: string };
    expect(header.kid).toBe(keyB.kid);
  });
});

describe("scope-restricted tokens on real routes", () => {
  test("a policy enforces the token's scope allowlist, fail-closed elsewhere", async () => {
    const { server } = await buildServer({ signedIn: true });
    const minted = await registerClient(server);
    const secret = minted.clientSecret ?? Redacted.make("");
    const { verifier, challenge } = await pkce();
    await run(
      server.grantConsent({
        tenantId: "tenant-a",
        userId: "user-1",
        clientId: minted.record.clientId,
        scope: ["mcp:tools"],
      }),
    );
    const decision = await run(
      server.authorize(
        {
          tenantId: "tenant-a",
          clientId: minted.record.clientId,
          redirectUri: "https://agent.example.com/callback",
          scope: ["mcp:tools"],
          codeChallenge: challenge,
          codeChallengeMethod: "S256",
        },
        "user-1",
      ),
    );
    if (!("redirectUrl" in decision)) throw new Error("expected redirect");
    const code = new URL(decision.redirectUrl).searchParams.get("code") ?? "";
    const tokens = await run(
      server.exchangeCode({
        tenantId: "tenant-a",
        clientId: minted.record.clientId,
        clientSecret: secret,
        code: Redacted.make(code),
        codeVerifier: verifier,
        redirectUri: "https://agent.example.com/callback",
      }),
    );
    const claims = await run(
      server.verifyAccessToken("tenant-a", Redacted.make(tokens.accessToken)),
    );

    // HttpAuthorization-style composition: claims become a restricted
    // machine principal; a policy gates machine principals on scope
    // attributes — unlisted permissions fail closed.
    const policy = Policy.define({
      resources: { mcp: ["tools", "resources"], data: ["export"] },
      conditions: {
        scopeMcpTools: (context) => {
          const scopes = context.principal.attributes?.scopes;
          return (
            Array.isArray(scopes) &&
            scopes.includes("mcp:tools") &&
            context.principal.kind === "service"
          );
        },
      },
      roles: {
        machine: { grants: [{ permission: "mcp:tools", when: "scopeMcpTools" }] },
        member: { grants: ["mcp:resources", "data:export"] },
      },
    });
    const principal = {
      id: `oauth:${claims.sub}`,
      kind: "service" as const,
      roles: ["machine"],
      tenantId: "tenant-a",
      attributes: { scopes: claims.scope.split(" "), clientId: claims.aud },
    };
    expect(policy.decide(principal, "mcp:tools").allowed).toBe(true);
    expect(policy.decide(principal, "mcp:resources").allowed).toBe(false);
    expect(policy.decide(principal, "data:export").allowed).toBe(false);
  });
});

describe("end-session", () => {
  test("hints are single-use within a bounded grace", async () => {
    const { server } = await buildServer();
    const started = await run(server.startEndSession("tenant-a", "user-1"));
    await run(server.completeEndSession("tenant-a", started.hint));
    const replay = await flip(server.completeEndSession("tenant-a", started.hint));
    expect(replay).toBeInstanceOf(InvalidAuthToken);
    // Grace period expiry.
    const second = await run(server.startEndSession("tenant-a", "user-1"));
    advance(6 * 60_000);
    const stale = await flip(server.completeEndSession("tenant-a", second.hint));
    expect(stale).toBeInstanceOf(InvalidAuthToken);
  });
});
