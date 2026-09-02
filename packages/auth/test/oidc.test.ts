import { describe, expect, test } from "bun:test";
import { load } from "@structure-ai/config";
import { Effect, Option, Redacted } from "effect";
import {
  AccountLinkDenied,
  type AuthAuditEvent,
  AuthDependencyError,
  type AuthEmail,
  allowAllRateLimiter,
  discoverOidc,
  InvalidCredentials,
  inMemoryAuthStore,
  makeAuth,
  type OAuthHttpClient,
  type OAuthProviderResolver,
  oidcProvisioningPolicy,
  oidcSettings,
} from "../src/index.js";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);
const _flip = <A, E>(effect: Effect.Effect<A, E>): Promise<E> => run(Effect.flip(effect));

// --- fake identity provider --------------------------------------------------------

interface IdTokenClaims {
  readonly iss: string;
  readonly sub: string;
  readonly aud: string;
  readonly exp: number;
  readonly email?: string;
  readonly email_verified?: boolean;
  readonly name?: string;
}

const ISSUER = "https://idp.example.com";
const CLIENT_ID = "client-test";

const base64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};

const makeFakeIdp = async (): Promise<{
  readonly httpClient: OAuthHttpClient;
  readonly sign: (claims: IdTokenClaims) => Promise<string>;
  readonly claims: (overrides?: Partial<IdTokenClaims>) => IdTokenClaims;
  readonly serve: (token: string) => void;
  readonly tamper: (token: string) => string;
}> => {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const publicJwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as Record<
    string,
    unknown
  >;
  const kid = "test-key-1";
  let currentToken = "";

  const claims = (overrides: Partial<IdTokenClaims> = {}): IdTokenClaims => ({
    iss: ISSUER,
    sub: "subject-1",
    aud: CLIENT_ID,
    exp: Math.floor(Date.now() / 1_000) + 3_600,
    email: "ada@example.com",
    email_verified: true,
    name: "Ada Lovelace",
    ...overrides,
  });

  const sign = async (tokenClaims: IdTokenClaims): Promise<string> => {
    const header = base64Url(
      new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT", kid })),
    );
    const payload = base64Url(new TextEncoder().encode(JSON.stringify(tokenClaims)));
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      keyPair.privateKey,
      new TextEncoder().encode(`${header}.${payload}`),
    );
    currentToken = `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
    return currentToken;
  };

  const discovery = {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    jwks_uri: `${ISSUER}/jwks.json`,
  };
  const jwks = { keys: [{ ...publicJwk, kid, use: "sig", alg: "RS256" }] };

  const httpClient: OAuthHttpClient = {
    execute: (request) =>
      Effect.tryPromise({
        try: async () => {
          const url = request.url;
          if (url === `${ISSUER}/.well-known/openid-configuration`) {
            return Response.json(discovery);
          }
          if (url === `${ISSUER}/jwks.json`) return Response.json(jwks);
          if (url === `${ISSUER}/token`) {
            return Response.json({
              access_token: "opaque-provider-access-token",
              token_type: "Bearer",
              id_token: currentToken,
            });
          }
          return new Response("not found", { status: 404 });
        },
        catch: (cause) =>
          new AuthDependencyError({ dependency: "fake-idp", operation: "request", cause }),
      }),
  };

  return {
    httpClient,
    sign,
    claims,
    serve: (token: string) => {
      currentToken = token;
    },
    tamper: (token: string) => {
      const [header, payload, signature] = token.split(".");
      return `${header}.${(payload ?? "").slice(0, -1)}${signature ?? ""}`;
    },
  };
};

const buildAuth = (httpClient: OAuthHttpClient, jit: boolean, defaultTenantId?: string) => {
  const memory = inMemoryAuthStore();
  const emails: Array<AuthEmail> = [];
  const audit: Array<AuthAuditEvent> = [];
  const settings = {
    issuer: new URL(ISSUER),
    clientId: CLIENT_ID,
    clientSecret: Redacted.make("client-secret-test"),
    jit,
    defaultTenantId:
      defaultTenantId === undefined ? Option.none<string>() : Option.some(defaultTenantId),
    label: Option.some("Corporate SSO"),
  };
  const auth = makeAuth({
    store: memory.store,
    resolveTenant: (tenantId) =>
      Effect.succeed({ baseUrl: new URL(`https://${tenantId}.example.com`) }),
    emailSender: { send: (email) => Effect.sync(() => emails.push(email)).pipe(Effect.asVoid) },
    rateLimiter: allowAllRateLimiter,
    audit: { record: (event) => Effect.sync(() => audit.push(event)) },
    oauthHttpClient: httpClient,
    oauthProviderResolver: {
      resolve: (_tenantId, provider) =>
        Effect.succeed(provider === "oidc" ? resolverProvider : undefined),
    } as OAuthProviderResolver,
    identityProvisioning: oidcProvisioningPolicy(settings as never),
  });
  return { auth, memory, emails, audit, settings };
};

let resolverProvider:
  | Awaited<Effect.Effect.Success<ReturnType<typeof discoverOidc>>>["provider"]
  | undefined;

interface FlowOutcome {
  readonly ok?: {
    readonly session: {
      readonly user: { readonly id: string; readonly email?: string };
      readonly token: Redacted.Redacted<string>;
    };
  };
  readonly error?: unknown;
}

const completeFlow = (
  auth: ReturnType<typeof buildAuth>["auth"],
  tenantId: string,
): Promise<FlowOutcome> =>
  Effect.runPromiseExit(
    Effect.flatMap(auth.beginOAuth(tenantId, "oidc"), (begun) =>
      auth.completeOAuth({
        tenantId,
        provider: "oidc",
        state: Redacted.make(new URL(begun.authorizationUrl).searchParams.get("state") ?? ""),
        code: Redacted.make("code-from-idp"),
      }),
    ),
  ).then(
    (exit): FlowOutcome =>
      exit._tag === "Success"
        ? { ok: exit.value }
        : { error: (exit.cause as { error?: unknown }).error },
  );

describe("generic OIDC login", () => {
  test("settings load with jit off by default and the secret redacted", async () => {
    const loaded = await run(
      load(oidcSettings, {
        overrides: {
          OIDC_ISSUER_URL: ISSUER,
          OIDC_CLIENT_ID: CLIENT_ID,
          OIDC_CLIENT_SECRET: "super-secret",
        },
      }),
    );
    expect(loaded.jit).toBe(false);
    expect(String(loaded.clientSecret)).not.toContain("super-secret");
  });

  test("JIT off refuses unknown identities without creating anything", async () => {
    const idp = await makeFakeIdp();
    await idp.sign(idp.claims());
    resolverProvider = (
      await run(
        discoverOidc(
          {
            issuer: new URL(ISSUER),
            credentials: { clientId: CLIENT_ID, clientSecret: Redacted.make("s") },
          },
          idp.httpClient,
        ),
      )
    ).provider;
    const { auth, memory } = buildAuth(idp.httpClient, false);
    const outcome = await completeFlow(auth, "tenant-a");
    expect(outcome.error).toBeInstanceOf(InvalidCredentials);
    expect(memory.snapshot().users).toHaveLength(0);
  });

  test("JIT off still signs in already-linked identities", async () => {
    const idp = await makeFakeIdp();
    await idp.sign(idp.claims());
    resolverProvider = (
      await run(
        discoverOidc(
          {
            issuer: new URL(ISSUER),
            credentials: { clientId: CLIENT_ID, clientSecret: Redacted.make("s") },
          },
          idp.httpClient,
        ),
      )
    ).provider;
    const { auth, memory, audit } = buildAuth(idp.httpClient, false);
    const seeded = {
      id: "user-1",
      tenantId: "tenant-a",
      email: "ada@example.com",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await run(memory.store.createMagicLinkUser(seeded));
    await run(
      memory.store.addOAuthIdentity({
        tenantId: "tenant-a",
        userId: "user-1",
        provider: "oidc",
        subject: "subject-1",
        email: "ada@example.com",
        createdAt: new Date(),
      }),
    );
    const outcome = await completeFlow(auth, "tenant-a");
    expect(outcome.ok?.session.user.id).toBe("user-1");
    expect(audit.some((event) => event.action === "oauth-complete")).toBe(true);
  });

  test("JIT on provisions unknown identities into the configured tenant only", async () => {
    const idp = await makeFakeIdp();
    await idp.sign(idp.claims());
    resolverProvider = (
      await run(
        discoverOidc(
          {
            issuer: new URL(ISSUER),
            credentials: { clientId: CLIENT_ID, clientSecret: Redacted.make("s") },
          },
          idp.httpClient,
        ),
      )
    ).provider;

    const inTenant = buildAuth(idp.httpClient, true, "tenant-a");
    const provisioned = await completeFlow(inTenant.auth, "tenant-a");
    expect(provisioned.ok?.session.user.email).toBe("ada@example.com");
    expect(inTenant.memory.snapshot().users).toHaveLength(1);
    expect(inTenant.audit.some((event) => event.action === "oauth-complete")).toBe(true);

    // The same JIT settings refuse provisioning in a second tenant.
    const otherTenant = buildAuth(idp.httpClient, true, "tenant-a");
    const refused = await completeFlow(otherTenant.auth, "tenant-b");
    expect(refused.error).toBeInstanceOf(InvalidCredentials);
    expect(otherTenant.memory.snapshot().users).toHaveLength(0);
  });

  test("tampered signatures, wrong issuers, and expired tokens all fail closed", async () => {
    const idp = await makeFakeIdp();
    resolverProvider = (
      await run(
        discoverOidc(
          {
            issuer: new URL(ISSUER),
            credentials: { clientId: CLIENT_ID, clientSecret: Redacted.make("s") },
          },
          idp.httpClient,
        ),
      )
    ).provider;
    const { auth, memory } = buildAuth(idp.httpClient, true, "tenant-a");

    // Tampered signature.
    const honest = await idp.sign(idp.claims());
    idp.serve(idp.tamper(honest));
    const tampered = await completeFlow(auth, "tenant-a");
    expect((tampered.error as { _tag?: string } | undefined)?._tag).toBe("AuthDependencyError");
    expect(memory.snapshot().users).toHaveLength(0);

    // Wrong issuer.
    await idp.sign(idp.claims({ iss: "https://evil.example.com" }));
    const evil = await completeFlow(auth, "tenant-a");
    expect((evil.error as { _tag?: string } | undefined)?._tag).toBe("AuthDependencyError");

    // Expired token.
    await idp.sign(idp.claims({ exp: Math.floor(Date.now() / 1_000) - 60 }));
    const expired = await completeFlow(auth, "tenant-a");
    expect((expired.error as { _tag?: string } | undefined)?._tag).toBe("AuthDependencyError");

    // The honest token still passes afterwards.
    await idp.sign(idp.claims());
    const valid = await completeFlow(auth, "tenant-a");
    expect(valid.ok?.session.user).toBeDefined();
  });

  test("unlinking removes the identity; re-sign-in hits the JIT gate again", async () => {
    const idp = await makeFakeIdp();
    await idp.sign(idp.claims());
    resolverProvider = (
      await run(
        discoverOidc(
          {
            issuer: new URL(ISSUER),
            credentials: { clientId: CLIENT_ID, clientSecret: Redacted.make("s") },
          },
          idp.httpClient,
        ),
      )
    ).provider;
    const { auth, memory, audit } = buildAuth(idp.httpClient, false);
    const seeded = {
      id: "user-1",
      tenantId: "tenant-a",
      email: "ada@example.com",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await run(memory.store.createMagicLinkUser(seeded));
    await run(
      memory.store.addOAuthIdentity({
        tenantId: "tenant-a",
        userId: "user-1",
        provider: "oidc",
        subject: "subject-1",
        email: "ada@example.com",
        createdAt: new Date(),
      }),
    );
    const outcome = await completeFlow(auth, "tenant-a");
    const token = outcome.ok?.session.token;
    expect(token).toBeDefined();
    await run(auth.unlinkOAuthIdentity("tenant-a", token ?? Redacted.make(""), "oidc"));
    expect(audit.some((event) => event.action === "oauth-unlink")).toBe(true);
    expect(memory.snapshot().oauthIdentities).toHaveLength(0);
    // Unknown again: JIT off refuses.
    const again = await completeFlow(auth, "tenant-a");
    // Re-linking is an explicit owner action: the email-matched account
    // exists, but automatic linking stays denied.
    expect(again.error).toBeInstanceOf(AccountLinkDenied);
  });
});
