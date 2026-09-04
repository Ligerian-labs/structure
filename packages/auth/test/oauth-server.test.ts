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
  type OAuthServerStore,
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

    // Replaying the rotated-away refresh token fails, and takes the pair it
    // was rotated into down with it (reuse revokes the family).
    const replay = await flip(
      server.refresh({
        tenantId: "tenant-a",
        clientId: minted.record.clientId,
        clientSecret: secret,
        refreshToken: Redacted.make(refreshToken),
      }),
    );
    expect(replay).toBeInstanceOf(InvalidAuthToken);
    const rotatedAfterReplay = await run(
      server.introspect({
        tenantId: "tenant-a",
        clientId: minted.record.clientId,
        clientSecret: secret,
        token: Redacted.make(rotated.refreshToken ?? ""),
      }),
    );
    expect(rotatedAfterReplay.active).toBe(false);
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
    // ...and new tokens are signed by key B, and verify under B (the key
    // their kid names) while A still stands as previous.
    const newToken = await issue();
    const header = JSON.parse(
      Buffer.from(newToken.split(".")[0] ?? "", "base64url").toString("utf8"),
    ) as { kid?: string };
    expect(header.kid).toBe(keyB.kid);
    expect((await run(server.verifyAccessToken("tenant-a", Redacted.make(newToken)))).sub).toBe(
      "user-1",
    );
    // A kid the server never held is refused whatever the signature.
    const [, payload, signature] = newToken.split(".");
    const foreignKid = Buffer.from(
      JSON.stringify({ alg: "RS256", typ: "JWT", kid: "unknown-kid" }),
    ).toString("base64url");
    expect(
      await flip(
        server.verifyAccessToken(
          "tenant-a",
          Redacted.make(`${foreignKid}.${payload}.${signature}`),
        ),
      ),
    ).toBeInstanceOf(InvalidAuthToken);
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

describe("access-token verification", () => {
  const b64url = (value: string): string => Buffer.from(value, "utf8").toString("base64url");
  const fromB64url = (value: string): string => Buffer.from(value, "base64url").toString("utf8");

  const issueFor = async (
    server: AuthorizationServer,
    userId: string,
  ): Promise<{ accessToken: string; clientId: string }> => {
    const minted = await run(
      server.registerClient(
        "tenant-a",
        {
          clientType: "public",
          redirectUris: ["https://agent.example.com/callback"],
          scopes: ["data:read", "data:write"],
        },
        { kind: "signed-in", userId },
      ),
    );
    const { verifier, challenge } = await pkce();
    await run(
      server.grantConsent({
        tenantId: "tenant-a",
        userId,
        clientId: minted.record.clientId,
        scope: ["data:read"],
      }),
    );
    const decision = await run(
      server.authorize(
        {
          tenantId: "tenant-a",
          clientId: minted.record.clientId,
          redirectUri: "https://agent.example.com/callback",
          scope: ["data:read"],
          codeChallenge: challenge,
          codeChallengeMethod: "S256",
        },
        userId,
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
    return { accessToken: tokens.accessToken, clientId: minted.record.clientId };
  };

  test("a token whose payload was rewritten under a garbage signature is refused", async () => {
    const { server } = await buildServer({ signedIn: true });
    const { accessToken } = await issueFor(server, "user-attacker");
    const genuine = await run(server.verifyAccessToken("tenant-a", Redacted.make(accessToken)));
    expect(genuine.sub).toBe("user-attacker");
    expect(genuine.scope).toBe("data:read");

    const [header, payload] = accessToken.split(".");
    const claims = JSON.parse(fromB64url(payload ?? "")) as Record<string, unknown>;
    const forged = `${header}.${b64url(
      JSON.stringify({ ...claims, sub: "user-victim", scope: "data:read data:write admin" }),
    )}.${b64url("not-a-signature")}`;
    expect(await flip(server.verifyAccessToken("tenant-a", Redacted.make(forged)))).toBeInstanceOf(
      InvalidAuthToken,
    );

    // The same payload with the signature segment removed or emptied.
    expect(
      await flip(server.verifyAccessToken("tenant-a", Redacted.make(`${header}.${payload}`))),
    ).toBeInstanceOf(InvalidAuthToken);
    expect(
      await flip(server.verifyAccessToken("tenant-a", Redacted.make(`${header}.${payload}.`))),
    ).toBeInstanceOf(InvalidAuthToken);
  });

  test("a payload re-signed under a foreign key carrying the server's kid is refused", async () => {
    const { server, keys } = await buildServer({ signedIn: true });
    const { accessToken } = await issueFor(server, "user-attacker");
    const [, payload] = accessToken.split(".");
    const claims = JSON.parse(fromB64url(payload ?? "")) as Record<string, unknown>;
    const foreign = await run(generateSigningKey());
    const forgedHeader = b64url(
      JSON.stringify({ alg: "RS256", typ: "JWT", kid: keys.current.kid }),
    );
    const forgedPayload = b64url(JSON.stringify({ ...claims, sub: "user-victim" }));
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      foreign.privateKey,
      new TextEncoder().encode(`${forgedHeader}.${forgedPayload}`),
    );
    const forged = `${forgedHeader}.${forgedPayload}.${Buffer.from(signature).toString("base64url")}`;
    expect(await flip(server.verifyAccessToken("tenant-a", Redacted.make(forged)))).toBeInstanceOf(
      InvalidAuthToken,
    );
  });

  test("a token whose header claims alg none is refused", async () => {
    const { server, keys } = await buildServer({ signedIn: true });
    const { accessToken } = await issueFor(server, "user-attacker");
    const [, payload, signature] = accessToken.split(".");
    const noneHeader = b64url(JSON.stringify({ alg: "none", typ: "JWT", kid: keys.current.kid }));
    expect(
      await flip(server.verifyAccessToken("tenant-a", Redacted.make(`${noneHeader}.${payload}.`))),
    ).toBeInstanceOf(InvalidAuthToken);
    expect(
      await flip(
        server.verifyAccessToken(
          "tenant-a",
          Redacted.make(`${noneHeader}.${payload}.${signature}`),
        ),
      ),
    ).toBeInstanceOf(InvalidAuthToken);
  });
});

describe("refresh-token reuse", () => {
  test("presenting a rotated-away refresh token revokes the whole family it started", async () => {
    const events: Array<{ readonly action: string; readonly userId?: string }> = [];
    const store = inMemoryOAuthServerStore();
    const key = await run(generateSigningKey());
    const server = makeAuthorizationServer({
      store,
      resolveTenant: (tenantId) =>
        Effect.succeed({ baseUrl: new URL(`https://${tenantId}.example.com`) }),
      signingKeys: { current: key },
      registration: { signedIn: true },
      primitives: { now: () => clock.value },
      audit: {
        record: (event) =>
          Effect.sync(() => {
            events.push({
              action: event.action,
              ...(event.userId === undefined ? {} : { userId: event.userId }),
            });
          }),
      },
    });
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
    const refresh = (token: string) =>
      server.refresh({
        tenantId: "tenant-a",
        clientId: minted.record.clientId,
        clientSecret: secret,
        refreshToken: Redacted.make(token),
      });
    const introspect = (token: string) =>
      run(
        server.introspect({
          tenantId: "tenant-a",
          clientId: minted.record.clientId,
          clientSecret: secret,
          token: Redacted.make(token),
        }),
      );
    // R1 → R2 (legitimate rotation), then R2 → R3: a live family of three generations.
    const second = await run(refresh(first.refreshToken ?? ""));
    const third = await run(refresh(second.refreshToken ?? ""));
    expect((await introspect(third.refreshToken ?? "")).active).toBe(true);
    expect((await introspect(third.accessToken)).active).toBe(true);

    // A thief replays R1: refused, and every descendant dies with it.
    expect(await flip(refresh(first.refreshToken ?? ""))).toBeInstanceOf(InvalidAuthToken);
    expect((await introspect(second.refreshToken ?? "")).active).toBe(false);
    expect((await introspect(third.refreshToken ?? "")).active).toBe(false);
    expect((await introspect(third.accessToken)).active).toBe(false);
    expect(
      await flip(server.verifyAccessToken("tenant-a", Redacted.make(third.accessToken))),
    ).toBeInstanceOf(InvalidAuthToken);
    expect(await flip(refresh(third.refreshToken ?? ""))).toBeInstanceOf(InvalidAuthToken);
    expect(events).toContainEqual({ action: "oauth-refresh-reuse", userId: "user-1" });

    // A family is exactly one grant: another exchange's tokens are untouched.
    const tokens = store.snapshot().tokens;
    const families = new Set(tokens.map((token) => token.familyId));
    expect(families.size).toBe(1);
    expect(tokens.every((token) => token.revokedAt !== undefined)).toBe(true);
  });
});

describe("refresh-token revocation versus rotation", () => {
  test("a refresh token revoked through the revocation endpoint is refused without being a reuse signal", async () => {
    const events: Array<string> = [];
    const store = inMemoryOAuthServerStore();
    const key = await run(generateSigningKey());
    const server = makeAuthorizationServer({
      store,
      resolveTenant: (tenantId) =>
        Effect.succeed({ baseUrl: new URL(`https://${tenantId}.example.com`) }),
      signingKeys: { current: key },
      registration: { signedIn: true },
      primitives: { now: () => clock.value },
      audit: { record: (event) => Effect.sync(() => void events.push(event.action)) },
    });
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
    const call = { tenantId: "tenant-a", clientId: minted.record.clientId, clientSecret: secret };
    const rotated = await run(
      server.refresh({ ...call, refreshToken: Redacted.make(first.refreshToken ?? "") }),
    );
    // The client signs out (RFC 7009) and a stale retry presents the same token.
    await run(server.revoke({ ...call, token: Redacted.make(rotated.refreshToken ?? "") }));
    expect(
      await flip(
        server.refresh({ ...call, refreshToken: Redacted.make(rotated.refreshToken ?? "") }),
      ),
    ).toBeInstanceOf(InvalidAuthToken);
    // Nothing else died and no theft was reported: the access token it was
    // rotated with is still live, and the audit sink saw nothing.
    const access = await run(
      server.introspect({ ...call, token: Redacted.make(rotated.accessToken) }),
    );
    expect(access.active).toBe(true);
    expect(events).toEqual([]);
    // The genuine reuse signal still fires: the token rotated away earlier.
    expect(
      await flip(
        server.refresh({ ...call, refreshToken: Redacted.make(first.refreshToken ?? "") }),
      ),
    ).toBeInstanceOf(InvalidAuthToken);
    expect(events).toEqual(["oauth-refresh-reuse"]);
    expect(
      (await run(server.introspect({ ...call, token: Redacted.make(rotated.accessToken) }))).active,
    ).toBe(false);
  });
});

describe("access-token verification: malformed signatures and algorithm confusion", () => {
  const b64url = (value: string): string => Buffer.from(value, "utf8").toString("base64url");

  const issueOne = async (server: AuthorizationServer): Promise<string> => {
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

  test("a signature segment that is not base64url is refused, never treated as verified", async () => {
    const { server } = await buildServer({ signedIn: true });
    const token = await issueOne(server);
    const [header, payload] = token.split(".");
    for (const garbage of ["!!!!", "@@@@", "a b c", "éééé", "%%%%"]) {
      expect(
        await flip(
          server.verifyAccessToken("tenant-a", Redacted.make(`${header}.${payload}.${garbage}`)),
        ),
      ).toBeInstanceOf(InvalidAuthToken);
    }
    expect((await run(server.verifyAccessToken("tenant-a", Redacted.make(token)))).sub).toBe(
      "user-1",
    );
  });

  test("a genuine RSA signature under a header advertising another algorithm is refused", async () => {
    const { server, keys } = await buildServer({ signedIn: true });
    const token = await issueOne(server);
    const [, payload] = token.split(".");
    for (const alg of ["HS256", "RS512", "PS256", "ES256", "NONE", "rs256"]) {
      const header = b64url(JSON.stringify({ alg, typ: "JWT", kid: keys.current.kid }));
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        keys.current.privateKey,
        new TextEncoder().encode(`${header}.${payload}`),
      );
      const confused = `${header}.${payload}.${Buffer.from(signature).toString("base64url")}`;
      expect(
        await flip(server.verifyAccessToken("tenant-a", Redacted.make(confused))),
      ).toBeInstanceOf(InvalidAuthToken);
    }
  });
});

describe("token families across grants", () => {
  test("every grant is its own family: one user's reuse never touches another user's tokens", async () => {
    const events: Array<string> = [];
    const store = inMemoryOAuthServerStore();
    const key = await run(generateSigningKey());
    const server = makeAuthorizationServer({
      store,
      resolveTenant: (tenantId) =>
        Effect.succeed({ baseUrl: new URL(`https://${tenantId}.example.com`) }),
      signingKeys: { current: key },
      registration: { signedIn: true },
      primitives: { now: () => clock.value },
      audit: { record: (event) => Effect.sync(() => void events.push(event.action)) },
    });
    const minted = await registerClient(server);
    const secret = minted.clientSecret ?? Redacted.make("");
    const call = { tenantId: "tenant-a", clientId: minted.record.clientId, clientSecret: secret };
    const grant = async (userId: string) => {
      const { verifier, challenge } = await pkce();
      await run(
        server.grantConsent({
          tenantId: "tenant-a",
          userId,
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
          userId,
        ),
      );
      if (!("redirectUrl" in decision)) throw new Error("expected redirect");
      const code = new URL(decision.redirectUrl).searchParams.get("code") ?? "";
      return run(
        server.exchangeCode({
          ...call,
          code: Redacted.make(code),
          codeVerifier: verifier,
          redirectUri: "https://agent.example.com/callback",
        }),
      );
    };
    const introspect = async (token: string) =>
      (await run(server.introspect({ ...call, token: Redacted.make(token) }))).active;

    const alice = await grant("user-alice");
    const bob = await grant("user-bob");
    const aliceAgain = await grant("user-alice");
    const families = new Set(store.snapshot().tokens.map((token) => token.familyId));
    expect(families.size).toBe(3);
    expect([...families].every((familyId) => typeof familyId === "string")).toBe(true);

    // Alice rotates, then her old token is replayed: her family dies, nobody else's.
    const rotated = await run(
      server.refresh({ ...call, refreshToken: Redacted.make(alice.refreshToken ?? "") }),
    );
    expect(
      await flip(
        server.refresh({ ...call, refreshToken: Redacted.make(alice.refreshToken ?? "") }),
      ),
    ).toBeInstanceOf(InvalidAuthToken);
    expect(await introspect(rotated.accessToken)).toBe(false);
    expect(await introspect(rotated.refreshToken ?? "")).toBe(false);
    expect(await introspect(bob.accessToken)).toBe(true);
    expect(await introspect(bob.refreshToken ?? "")).toBe(true);
    expect(await introspect(aliceAgain.accessToken)).toBe(true);
    expect(await introspect(aliceAgain.refreshToken ?? "")).toBe(true);
    expect(events).toEqual(["oauth-refresh-reuse"]);
  });
});

describe("in-memory token store: family revocation", () => {
  test("stays inside the tenant and keeps an earlier revocation time", async () => {
    const store = inMemoryOAuthServerStore();
    const at = new Date("2026-08-20T12:00:00.000Z");
    const earlier = new Date("2026-08-20T11:00:00.000Z");
    const later = new Date("2026-08-20T13:00:00.000Z");
    const member = (tenantId: string, tokenId: string, revokedAt?: Date) =>
      run(
        store.putToken({
          tenantId,
          tokenId,
          kind: "access",
          clientId: "as_c1",
          userId: "user-1",
          scope: ["mcp:tools"],
          familyId: "family-shared",
          expiresAt: later,
          ...(revokedAt === undefined ? {} : { revokedAt }),
          createdAt: at,
        }),
      );
    await member("tenant-a", "a-live");
    await member("tenant-a", "a-dead", earlier);
    await member("tenant-b", "b-live");
    await run(store.revokeFamily("tenant-a", "family-shared", at));
    expect((await run(store.findTokenById("tenant-a", "a-live")))?.revokedAt).toEqual(at);
    expect((await run(store.findTokenById("tenant-a", "a-dead")))?.revokedAt).toEqual(earlier);
    expect((await run(store.findTokenById("tenant-b", "b-live")))?.revokedAt).toBeUndefined();
  });

  test("rotation lands once, on a live token only, and never on a revoked one", async () => {
    const store = inMemoryOAuthServerStore();
    const at = new Date("2026-08-20T12:00:00.000Z");
    const later = new Date("2026-08-20T13:00:00.000Z");
    const refresh = (tokenId: string) =>
      run(
        store.putToken({
          tenantId: "tenant-a",
          tokenId,
          kind: "refresh",
          clientId: "as_c1",
          userId: "user-1",
          scope: ["mcp:tools"],
          tokenHash: `${tokenId}-hash`,
          familyId: "family-1",
          expiresAt: later,
          createdAt: at,
        }),
      );
    await refresh("r-live");
    await refresh("r-revoked");
    expect(await run(store.rotateToken("tenant-a", "r-live", at))).toBe(true);
    expect(await run(store.rotateToken("tenant-a", "r-live", later))).toBe(false);
    expect((await run(store.findTokenById("tenant-a", "r-live")))?.rotatedAt).toEqual(at);
    await run(store.revokeToken("tenant-a", "r-revoked", at));
    expect(await run(store.rotateToken("tenant-a", "r-revoked", later))).toBe(false);
    const revoked = await run(store.findTokenById("tenant-a", "r-revoked"));
    expect(revoked?.rotatedAt).toBeUndefined();
    expect(revoked?.revokedAt).toEqual(at);
    expect(await run(store.rotateToken("tenant-b", "r-live", later))).toBe(false);
  });
});

describe("concurrent refresh of one token", () => {
  test("a rotation that did not land is a lost race: refused, and reuse if the token was rotated away", async () => {
    const events: Array<string> = [];
    const real = inMemoryOAuthServerStore();
    // The other presenter wins the compare-and-set: the token ends up rotated
    // away, and OUR rotation lands nothing.
    let raced = false;
    const store: OAuthServerStore = {
      ...real,
      rotateToken: (tenantId, tokenId, now) =>
        raced
          ? real.rotateToken(tenantId, tokenId, now)
          : real.rotateToken(tenantId, tokenId, now).pipe(
              Effect.map(() => {
                raced = true;
                return false;
              }),
            ),
    };
    const key = await run(generateSigningKey());
    const server = makeAuthorizationServer({
      store,
      resolveTenant: (tenantId) =>
        Effect.succeed({ baseUrl: new URL(`https://${tenantId}.example.com`) }),
      signingKeys: { current: key },
      registration: { signedIn: true },
      primitives: { now: () => clock.value },
      audit: { record: (event) => Effect.sync(() => void events.push(event.action)) },
    });
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
    const call = { tenantId: "tenant-a", clientId: minted.record.clientId, clientSecret: secret };
    const first = await run(
      server.exchangeCode({
        ...call,
        code: Redacted.make(code),
        codeVerifier: verifier,
        redirectUri: "https://agent.example.com/callback",
      }),
    );
    expect(
      await flip(
        server.refresh({ ...call, refreshToken: Redacted.make(first.refreshToken ?? "") }),
      ),
    ).toBeInstanceOf(InvalidAuthToken);
    expect(raced).toBe(true);
    // The loser of the race is treated as reuse: the family is gone, audited.
    expect(events).toEqual(["oauth-refresh-reuse"]);
    expect(
      (await run(server.introspect({ ...call, token: Redacted.make(first.accessToken) }))).active,
    ).toBe(false);
    expect(real.snapshot().tokens.every((token) => token.revokedAt !== undefined)).toBe(true);
  });
});

describe("reuse detection is idempotent", () => {
  test("replaying one dead token fifty times audits the reuse once and revokes nothing more", async () => {
    const events: Array<string> = [];
    const store = inMemoryOAuthServerStore();
    const key = await run(generateSigningKey());
    const server = makeAuthorizationServer({
      store,
      resolveTenant: (tenantId) =>
        Effect.succeed({ baseUrl: new URL(`https://${tenantId}.example.com`) }),
      signingKeys: { current: key },
      registration: { signedIn: true },
      primitives: { now: () => clock.value },
      audit: { record: (event) => Effect.sync(() => void events.push(event.action)) },
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
        code: Redacted.make(code),
        codeVerifier: verifier,
        redirectUri: "https://agent.example.com/callback",
      }),
    );
    const replay = () =>
      flip(
        server.refresh({
          tenantId: "tenant-a",
          clientId: minted.record.clientId,
          refreshToken: Redacted.make(first.refreshToken ?? ""),
        }),
      );
    await run(
      server.refresh({
        tenantId: "tenant-a",
        clientId: minted.record.clientId,
        refreshToken: Redacted.make(first.refreshToken ?? ""),
      }),
    );
    for (let index = 0; index < 50; index++) {
      expect(await replay()).toBeInstanceOf(InvalidAuthToken);
    }
    expect(events).toEqual(["oauth-refresh-reuse"]);
    // The store answers how much a family revocation actually did.
    expect(await run(store.revokeFamily("tenant-a", "no-such-family", clock.value))).toBe(0);
  });
});

/** One grant on a server over `store`, with the usual public client; returns the first pair and a call context. */
const grantOn = async (
  store: OAuthServerStore,
  events: Array<string>,
): Promise<{
  server: AuthorizationServer;
  first: { accessToken: string; refreshToken?: string };
  call: { tenantId: string; clientId: string };
}> => {
  const key = await run(generateSigningKey());
  const server = makeAuthorizationServer({
    store,
    resolveTenant: (tenantId) =>
      Effect.succeed({ baseUrl: new URL(`https://${tenantId}.example.com`) }),
    signingKeys: { current: key },
    registration: { signedIn: true },
    primitives: { now: () => clock.value },
    audit: { record: (event) => Effect.sync(() => void events.push(event.action)) },
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
      code: Redacted.make(code),
      codeVerifier: verifier,
      redirectUri: "https://agent.example.com/callback",
    }),
  );
  return { server, first, call: { tenantId: "tenant-a", clientId: minted.record.clientId } };
};

describe("the winner of a concurrent refresh", () => {
  test("is refused too when the loser's sweep already killed its fresh pair", async () => {
    const events: Array<string> = [];
    const real = inMemoryOAuthServerStore();
    // Our rotation lands, but the other presenter's family revocation runs
    // before we answer: the pair we just minted is already dead.
    let swept = false;
    const store: OAuthServerStore = {
      ...real,
      rotateToken: (tenantId, tokenId, now) =>
        Effect.gen(function* () {
          const landed = yield* real.rotateToken(tenantId, tokenId, now);
          if (landed && !swept) {
            swept = true;
            const record = yield* real.findTokenById(tenantId, tokenId);
            yield* real.revokeFamily(tenantId, record?.familyId ?? tokenId, now);
          }
          return landed;
        }),
    };
    const { server, first, call } = await grantOn(store, events);
    expect(
      await flip(
        server.refresh({ ...call, refreshToken: Redacted.make(first.refreshToken ?? "") }),
      ),
    ).toBeInstanceOf(InvalidAuthToken);
    expect(swept).toBe(true);
    // Nothing usable was handed out, and nothing is live.
    expect(real.snapshot().tokens.every((token) => token.revokedAt !== undefined)).toBe(true);
  });
});

describe("refresh under a revocation that lands mid-flight", () => {
  test("a rotation lost to a plain revocation is refused without a reuse alarm, and leaves nothing live", async () => {
    const events: Array<string> = [];
    const real = inMemoryOAuthServerStore();
    // The client's own sign-out (RFC 7009) commits between our read and our rotation.
    let interposed = false;
    const store: OAuthServerStore = {
      ...real,
      rotateToken: (tenantId, tokenId, now) =>
        Effect.gen(function* () {
          if (!interposed) {
            interposed = true;
            yield* real.revokeToken(tenantId, tokenId, now);
          }
          return yield* real.rotateToken(tenantId, tokenId, now);
        }),
    };
    const { server, first, call } = await grantOn(store, events);
    expect(
      await flip(
        server.refresh({ ...call, refreshToken: Redacted.make(first.refreshToken ?? "") }),
      ),
    ).toBeInstanceOf(InvalidAuthToken);
    expect(interposed).toBe(true);
    expect(events).toEqual([]);
    expect(real.snapshot().tokens.every((token) => token.revokedAt !== undefined)).toBe(true);
    expect(real.snapshot().tokens.every((token) => token.rotatedAt === undefined)).toBe(true);
  });

  test("a lost race whose family sweep revoked nothing raises no alarm either", async () => {
    const events: Array<string> = [];
    const real = inMemoryOAuthServerStore();
    const store: OAuthServerStore = {
      ...real,
      // Someone else rotates it first, every time; and the family is already empty of live tokens.
      rotateToken: (tenantId, tokenId, now) =>
        real.rotateToken(tenantId, tokenId, now).pipe(Effect.map(() => false)),
      revokeFamily: () => Effect.succeed(0),
    };
    const { server, first, call } = await grantOn(store, events);
    for (let index = 0; index < 20; index++) {
      expect(
        await flip(
          server.refresh({ ...call, refreshToken: Redacted.make(first.refreshToken ?? "") }),
        ),
      ).toBeInstanceOf(InvalidAuthToken);
    }
    expect(events).toEqual([]);
  });
});

describe("refresh mints before it rotates", () => {
  test("both records of the fresh pair are stored before the old token is rotated", async () => {
    const events: Array<string> = [];
    const real = inMemoryOAuthServerStore();
    const log: Array<string> = [];
    const store: OAuthServerStore = {
      ...real,
      putToken: (record) =>
        real
          .putToken(record)
          .pipe(Effect.tap(() => Effect.sync(() => void log.push(`put:${record.kind}`)))),
      rotateToken: (tenantId, tokenId, now) =>
        real
          .rotateToken(tenantId, tokenId, now)
          .pipe(Effect.tap(() => Effect.sync(() => void log.push("rotate")))),
    };
    const { server, first, call } = await grantOn(store, events);
    log.length = 0;
    await run(server.refresh({ ...call, refreshToken: Redacted.make(first.refreshToken ?? "") }));
    expect(log).toEqual(["put:access", "put:refresh", "rotate"]);
  });
});

describe("the fresh pair vanishing before the re-read", () => {
  test("refuses and leaves nothing live rather than orphaning the pair", async () => {
    const events: Array<string> = [];
    const real = inMemoryOAuthServerStore();
    // A cleanup deletes the just-minted refresh record in the window before
    // the re-read: the store answers "absent" once.
    let vanished = false;
    const store: OAuthServerStore = {
      ...real,
      findTokenById: (tenantId, tokenId) =>
        Effect.gen(function* () {
          const found = yield* real.findTokenById(tenantId, tokenId);
          if (found?.kind === "refresh" && found.revokedAt === undefined && !vanished) {
            vanished = true;
            return undefined;
          }
          return found;
        }),
    };
    const { server, first, call } = await grantOn(store, events);
    expect(
      await flip(
        server.refresh({ ...call, refreshToken: Redacted.make(first.refreshToken ?? "") }),
      ),
    ).toBeInstanceOf(InvalidAuthToken);
    expect(vanished).toBe(true);
    expect(events).toEqual([]);
    expect(real.snapshot().tokens.every((token) => token.revokedAt !== undefined)).toBe(true);
  });
});

describe("issued token shape", () => {
  test("neither exchange nor refresh exposes anything beyond the public pair", async () => {
    const { server, first, call } = await grantOn(inMemoryOAuthServerStore(), []);
    const publicKeys = ["accessToken", "expiresIn", "refreshToken", "scope", "tokenType"];
    expect(Object.keys(first).sort()).toEqual(publicKeys);
    const rotated = await run(
      server.refresh({ ...call, refreshToken: Redacted.make(first.refreshToken ?? "") }),
    );
    expect(Object.keys(rotated).sort()).toEqual(publicKeys);
    expect(JSON.stringify(rotated)).not.toContain("refreshTokenId");
  });
});

describe("the fresh pair partly swept before the re-read", () => {
  test("a revoked fresh refresh record refuses and takes its live access sibling with it", async () => {
    const events: Array<string> = [];
    const real = inMemoryOAuthServerStore();
    // Only the fresh refresh record was revoked in the window (a partial
    // sweep): its access sibling is still live when we re-read.
    let partial = false;
    const store: OAuthServerStore = {
      ...real,
      findTokenById: (tenantId, tokenId) =>
        Effect.gen(function* () {
          const found = yield* real.findTokenById(tenantId, tokenId);
          if (found?.kind === "refresh" && found.revokedAt === undefined && !partial) {
            partial = true;
            yield* real.revokeToken(tenantId, tokenId, clock.value);
            return yield* real.findTokenById(tenantId, tokenId);
          }
          return found;
        }),
    };
    const { server, first, call } = await grantOn(store, events);
    expect(
      await flip(
        server.refresh({ ...call, refreshToken: Redacted.make(first.refreshToken ?? "") }),
      ),
    ).toBeInstanceOf(InvalidAuthToken);
    expect(partial).toBe(true);
    expect(events).toEqual([]);
    expect(real.snapshot().tokens.filter((token) => token.revokedAt === undefined)).toEqual([]);
  });
});
