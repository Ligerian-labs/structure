import { expect, test } from "bun:test";
import {
  type ApiKeyRecord,
  type ApiKeyStore,
  type AuthStore,
  type AuthUser,
  IdentityConflict,
  type OAuthServerStore,
  type OAuthStateRecord,
  type PasskeyRecord,
  type PasswordCredential,
  type SessionRecord,
  type TotpRecord,
} from "@structure-ai/auth";
import { Effect, Redacted } from "effect";

export interface StoreHarness {
  readonly store: AuthStore;
  readonly remake: () => AuthStore;
  readonly apiKeys: ApiKeyStore;
  readonly remakeApiKeys: () => ApiKeyStore;
  readonly close: () => Promise<void>;
}

export type MakeHarness = () => Promise<StoreHarness>;

const now = new Date("2026-08-20T12:00:00.000Z");
const later = new Date("2026-08-20T13:00:00.000Z");
const expired = new Date("2026-08-20T11:00:00.000Z");

const user = (tenantId: string, id: string, email: string): AuthUser => ({
  id,
  tenantId,
  email,
  emailVerified: false,
  createdAt: now,
  updatedAt: now,
});

const password = (tenantId: string, userId: string, email: string): PasswordCredential => ({
  tenantId,
  userId,
  email,
  passwordHash: "argon2id-hash",
  updatedAt: now,
});

const session = (tenantId: string, id: string, userId: string): SessionRecord => ({
  id,
  tenantId,
  userId,
  tokenHash: `${id}-hash`,
  createdAt: now,
  expiresAt: later,
});

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);
const fail = <A, E>(effect: Effect.Effect<A, E>): Promise<E> => run(Effect.flip(effect));

const withHarness = async (
  makeHarness: MakeHarness,
  body: (harness: StoreHarness) => Promise<void>,
): Promise<void> => {
  const harness = await makeHarness();
  try {
    await body(harness);
  } finally {
    await harness.close();
  }
};

export const registerStoreScenarios = (makeHarness: MakeHarness): void => {
  test("persists users across store instances and isolates tenant uniqueness", () =>
    withHarness(makeHarness, async ({ store, remake }) => {
      await run(
        store.createPasswordUser(
          user("tenant-a", "user-a", "ada@example.com"),
          password("tenant-a", "user-a", "ada@example.com"),
        ),
      );
      await run(
        store.createPasswordUser(
          user("tenant-b", "user-b", "ada@example.com"),
          password("tenant-b", "user-b", "ada@example.com"),
        ),
      );

      const duplicate = await fail(
        store.createPasswordUser(
          user("tenant-a", "duplicate", "ada@example.com"),
          password("tenant-a", "duplicate", "ada@example.com"),
        ),
      );
      expect(duplicate).toBeInstanceOf(IdentityConflict);
      expect(await run(store.findUserById("tenant-a", "duplicate"))).toBeUndefined();
      expect((await run(remake().findUserByEmail("tenant-a", "ada@example.com")))?.id).toBe(
        "user-a",
      );
      expect((await run(remake().findUserByEmail("tenant-b", "ada@example.com")))?.id).toBe(
        "user-b",
      );
    }));

  test("replaces and atomically consumes one-time tokens", () =>
    withHarness(makeHarness, async ({ store }) => {
      await run(
        store.putOneTimeToken({
          tenantId: "tenant-a",
          purpose: "magic-link",
          tokenHash: "old-hash",
          email: "ada@example.com",
          expiresAt: later,
        }),
      );
      await run(
        store.putOneTimeToken({
          tenantId: "tenant-a",
          purpose: "magic-link",
          tokenHash: "new-hash",
          email: "ada@example.com",
          expiresAt: later,
        }),
      );
      expect(
        await run(store.consumeOneTimeToken("tenant-a", "magic-link", "old-hash", now)),
      ).toBeUndefined();
      const consumed = await Promise.all([
        run(store.consumeOneTimeToken("tenant-a", "magic-link", "new-hash", now)),
        run(store.consumeOneTimeToken("tenant-a", "magic-link", "new-hash", now)),
      ]);
      expect(consumed.filter((record) => record !== undefined)).toHaveLength(1);

      await run(
        store.putOneTimeToken({
          tenantId: "tenant-a",
          purpose: "password-reset",
          tokenHash: "expired-hash",
          email: "ada@example.com",
          expiresAt: expired,
        }),
      );
      expect(
        await run(store.consumeOneTimeToken("tenant-a", "password-reset", "expired-hash", now)),
      ).toBeUndefined();
    }));

  test("replaces a password and revokes only that tenant users sessions atomically", () =>
    withHarness(makeHarness, async ({ store }) => {
      await run(
        store.createPasswordUser(
          user("tenant-a", "shared-user", "a@example.com"),
          password("tenant-a", "shared-user", "a@example.com"),
        ),
      );
      await run(
        store.createPasswordUser(
          user("tenant-b", "shared-user", "b@example.com"),
          password("tenant-b", "shared-user", "b@example.com"),
        ),
      );
      await run(store.createSession(session("tenant-a", "session-a", "shared-user")));
      await run(store.createSession(session("tenant-b", "session-b", "shared-user")));

      await run(
        store.replacePasswordAndRevokeSessions(
          "tenant-a",
          "shared-user",
          "new-argon2id-hash",
          later,
        ),
      );

      expect((await run(store.findPassword("tenant-a", "a@example.com")))?.passwordHash).toBe(
        "new-argon2id-hash",
      );
      expect(await run(store.findSession("tenant-a", "session-a-hash", now))).toBeUndefined();
      expect(await run(store.findSession("tenant-b", "session-b-hash", now))).toBeDefined();
    }));

  test("consumes OAuth state once and enforces provider identity uniqueness", () =>
    withHarness(makeHarness, async ({ store }) => {
      const state: OAuthStateRecord = {
        tenantId: "tenant-a",
        provider: "github",
        stateHash: "state-hash",
        codeVerifier: Redacted.make("pkce-verifier"),
        redirectUri: "https://example.com/auth/oauth/github/callback",
        expiresAt: later,
      };
      await run(store.putOAuthState(state));
      const consumed = await run(store.consumeOAuthState("tenant-a", "state-hash", now));
      expect(Redacted.value(consumed?.codeVerifier ?? Redacted.make(""))).toBe("pkce-verifier");
      expect(await run(store.consumeOAuthState("tenant-a", "state-hash", now))).toBeUndefined();

      const oauthUser = user("tenant-a", "oauth-user", "oauth@example.com");
      await run(
        store.createOAuthUser(oauthUser, {
          tenantId: "tenant-a",
          userId: oauthUser.id,
          provider: "github",
          subject: "github-subject",
          email: "oauth@example.com",
          createdAt: now,
        }),
      );
      expect(
        (await run(store.findOAuthIdentity("tenant-a", "github", "github-subject")))?.userId,
      ).toBe("oauth-user");
      expect(
        await fail(
          store.addOAuthIdentity({
            tenantId: "tenant-a",
            userId: oauthUser.id,
            provider: "github",
            subject: "github-subject",
            createdAt: now,
          }),
        ),
      ).toBeInstanceOf(IdentityConflict);
    }));

  test("consumes passkey challenges and compare-and-sets signature counters", () =>
    withHarness(makeHarness, async ({ store }) => {
      await run(
        store.createMagicLinkUser({
          ...user("tenant-a", "passkey-user", "passkey@example.com"),
          emailVerified: true,
        }),
      );
      await run(
        store.putPasskeyChallenge({
          tenantId: "tenant-a",
          purpose: "authentication",
          challengeHash: "challenge-hash",
          userId: "passkey-user",
          expiresAt: later,
        }),
      );
      expect(
        (
          await run(
            store.consumePasskeyChallenge("tenant-a", "authentication", "challenge-hash", now),
          )
        )?.userId,
      ).toBe("passkey-user");
      expect(
        await run(
          store.consumePasskeyChallenge("tenant-a", "authentication", "challenge-hash", now),
        ),
      ).toBeUndefined();

      const passkey: PasskeyRecord = {
        tenantId: "tenant-a",
        userId: "passkey-user",
        credentialId: "credential-id",
        publicKey: "public-key",
        algorithm: "ES256",
        counter: 1,
        transports: ["internal", "hybrid"],
        createdAt: now,
      };
      await run(store.addPasskey(passkey));
      await run(store.updatePasskeyCounter("tenant-a", "credential-id", 1, 2));
      expect((await run(store.findPasskey("tenant-a", "credential-id")))?.counter).toBe(2);
      expect(
        await fail(store.updatePasskeyCounter("tenant-a", "credential-id", 1, 3)),
      ).toBeInstanceOf(IdentityConflict);
      expect(await run(store.listPasskeys("tenant-a", "passkey-user"))).toHaveLength(1);
    }));
};

export const registerApiKeyScenarios = (makeHarness: MakeHarness): void => {
  const apiKeyRecord = (keyId: string): ApiKeyRecord => ({
    tenantId: "tenant-a",
    keyId,
    userId: "user-1",
    scopes: ["data:export"],
    secretHash: `hash-${keyId}`,
    pepperVersion: 1,
    workspaceId: "ws-1",
    createdAt: now,
  });

  test("api keys persist, track last use, rotate hashes, and revoke", () =>
    withHarness(makeHarness, async ({ apiKeys, remakeApiKeys }) => {
      await run(apiKeys.create(apiKeyRecord("key-1")));

      const persisted = await run(remakeApiKeys().findByKeyId("tenant-a", "key-1"));
      expect(persisted?.secretHash).toBe("hash-key-1");
      expect(persisted?.scopes).toEqual(["data:export"]);

      await run(apiKeys.markUsed("tenant-a", "key-1", later));
      const touched = await run(apiKeys.findByKeyId("tenant-a", "key-1"));
      expect(touched?.lastUsedAt).toEqual(later);

      // Lazy pepper rotation rewrites hash + version together.
      await run(apiKeys.replaceHash("tenant-a", "key-1", "hash-v2", 2));
      const rotated = await run(apiKeys.findByKeyId("tenant-a", "key-1"));
      expect(rotated?.secretHash).toBe("hash-v2");
      expect(rotated?.pepperVersion).toBe(2);

      await run(apiKeys.revoke("tenant-a", "key-1", later));
      const revoked = await run(apiKeys.findByKeyId("tenant-a", "key-1"));
      expect(revoked?.revokedAt).toEqual(later);
      expect((await run(apiKeys.listByUser("tenant-a", "user-1"))).map((r) => r.keyId)).toEqual([
        "key-1",
      ]);
    }));

  test("api keys stay tenant-scoped", () =>
    withHarness(makeHarness, async ({ apiKeys }) => {
      await run(apiKeys.create(apiKeyRecord("key-1")));
      expect(await run(apiKeys.findByKeyId("tenant-b", "key-1"))).toBeUndefined();
    }));
};

export const registerTotpScenarios = (makeHarness: MakeHarness): void => {
  const enrollment = (userId: string): TotpRecord => ({
    tenantId: "tenant-a",
    userId,
    secretBase32: "JBSWY3DPEHPK3PXP",
    confirmed: false,
    recoveryCodeHashes: [],
    failedAttempts: 0,
    enrolledAt: now,
  });

  test("totp enrollment persists, confirms once, and stays tenant-scoped", () =>
    withHarness(makeHarness, async ({ store, remake }) => {
      await run(
        store.createPasswordUser(
          user("tenant-a", "user-1", "ada@example.com"),
          password("tenant-a", "user-1", "ada@example.com"),
        ),
      );
      await run(store.putTotpSecret(enrollment("user-1")));
      const persisted = await run(remake().findTotp("tenant-a", "user-1"));
      expect(persisted?.confirmed).toBe(false);

      const confirmed = await run(
        store.confirmTotp("tenant-a", "user-1", ["hash-a", "hash-b"], later),
      );
      expect(confirmed?.confirmed).toBe(true);
      expect(confirmed?.recoveryCodeHashes).toEqual(["hash-a", "hash-b"]);

      // Confirming again is a no-op (nothing pending left to confirm).
      const again = await run(store.confirmTotp("tenant-a", "user-1", ["hash-c"], later));
      expect(again).toBeUndefined();
      const unchanged = await run(store.findTotp("tenant-a", "user-1"));
      expect(unchanged?.recoveryCodeHashes).toEqual(["hash-a", "hash-b"]);

      expect(await run(store.findTotp("tenant-b", "user-1"))).toBeUndefined();
    }));

  test("failure counters lock at the threshold and reset on success", () =>
    withHarness(makeHarness, async ({ store }) => {
      await run(
        store.createPasswordUser(
          user("tenant-a", "user-1", "ada@example.com"),
          password("tenant-a", "user-1", "ada@example.com"),
        ),
      );
      await run(store.putTotpSecret(enrollment("user-1")));
      await run(store.confirmTotp("tenant-a", "user-1", ["hash-a"], later));
      const first = await run(
        store.recordTotpFailure({
          tenantId: "tenant-a",
          userId: "user-1",
          threshold: 3,
          cooldownMillis: 900_000,
          now: later,
        }),
      );
      expect(first.locked).toBe(false);
      const second = await run(
        store.recordTotpFailure({
          tenantId: "tenant-a",
          userId: "user-1",
          threshold: 3,
          cooldownMillis: 900_000,
          now: later,
        }),
      );
      expect(second.locked).toBe(false);
      const third = await run(
        store.recordTotpFailure({
          tenantId: "tenant-a",
          userId: "user-1",
          threshold: 3,
          cooldownMillis: 900_000,
          now: later,
        }),
      );
      expect(third.locked).toBe(true);
      expect(third.lockedUntil?.getTime()).toBe(later.getTime() + 900_000);

      await run(store.resetTotpFailures("tenant-a", "user-1"));
      const cleared = await run(store.findTotp("tenant-a", "user-1"));
      expect(cleared?.failedAttempts).toBe(0);
      expect(cleared?.lockedUntil).toBeUndefined();
    }));

  test("recovery codes are single-use and removal clears the enrollment", () =>
    withHarness(makeHarness, async ({ store }) => {
      await run(
        store.createPasswordUser(
          user("tenant-a", "user-1", "ada@example.com"),
          password("tenant-a", "user-1", "ada@example.com"),
        ),
      );
      await run(store.putTotpSecret(enrollment("user-1")));
      await run(store.confirmTotp("tenant-a", "user-1", ["hash-a", "hash-b"], later));
      expect(await run(store.consumeRecoveryCode("tenant-a", "user-1", "hash-a"))).toBe(true);
      expect(await run(store.consumeRecoveryCode("tenant-a", "user-1", "hash-a"))).toBe(false);
      expect(await run(store.consumeRecoveryCode("tenant-a", "user-1", "hash-b"))).toBe(true);
      const remaining = await run(store.findTotp("tenant-a", "user-1"));
      expect(remaining?.recoveryCodeHashes).toEqual([]);

      await run(store.removeTotp("tenant-a", "user-1"));
      expect(await run(store.findTotp("tenant-a", "user-1"))).toBeUndefined();
    }));

  test("sessions persist their elevation state", () =>
    withHarness(makeHarness, async ({ store, remake }) => {
      await run(
        store.createPasswordUser(
          user("tenant-a", "user-1", "ada@example.com"),
          password("tenant-a", "user-1", "ada@example.com"),
        ),
      );
      const pending = {
        ...session("tenant-a", "sess-1", "user-1"),
        expiresAt: new Date(later.getTime() + 3_600_000),
      };
      await run(store.createSession(pending));
      await run(store.elevateSession("tenant-a", `${"sess-1"}-hash`, later));
      const persisted = await run(
        remake().findSession("tenant-a", "sess-1-hash", new Date(later.getTime() + 1)),
      );
      expect(persisted?.elevatedAt).toEqual(later);
    }));
};

export interface OAuthServerHarness {
  readonly oauthServer: OAuthServerStore;
  readonly remakeOAuthServer: () => OAuthServerStore;
}

export const registerOAuthServerScenarios = (
  makeHarness: () => Promise<OAuthServerHarness>,
): void => {
  test("oauth server state persists and consumes single-use atomically", async () => {
    const harness = await makeHarness();
    try {
      const store = harness.oauthServer;
      const remake = harness.remakeOAuthServer();
      const at = now;
      await run(
        store.putClient({
          tenantId: "tenant-a",
          clientId: "as_client-1",
          clientType: "confidential",
          secretHash: "hash-1",
          redirectUris: ["https://agent.example.com/callback"],
          scopes: ["mcp:tools"],
          createdAt: at,
        }),
      );
      const client = await run(remake.findClient("tenant-a", "as_client-1"));
      expect(client?.secretHash).toBe("hash-1");
      expect(client?.redirectUris).toEqual(["https://agent.example.com/callback"]);

      await run(
        store.putAuthorizationCode({
          tenantId: "tenant-a",
          codeHash: "code-hash",
          clientId: "as_client-1",
          userId: "user-1",
          redirectUri: "https://agent.example.com/callback",
          scope: ["mcp:tools"],
          codeChallenge: "challenge",
          expiresAt: later,
        }),
      );
      const consumed = await run(remake.consumeAuthorizationCode("tenant-a", "code-hash", now));
      expect(consumed?.clientId).toBe("as_client-1");
      const replay = await run(store.consumeAuthorizationCode("tenant-a", "code-hash", now));
      expect(replay).toBeUndefined();

      await run(
        store.putConsent({
          tenantId: "tenant-a",
          clientId: "as_client-1",
          userId: "user-1",
          scope: ["mcp:tools"],
          grantedAt: at,
        }),
      );
      expect((await run(remake.findConsent("tenant-a", "as_client-1", "user-1")))?.scope).toEqual([
        "mcp:tools",
      ]);

      await run(
        store.putToken({
          tenantId: "tenant-a",
          tokenId: "token-1",
          kind: "refresh",
          clientId: "as_client-1",
          userId: "user-1",
          scope: ["mcp:tools"],
          tokenHash: "token-hash",
          expiresAt: later,
          createdAt: at,
        }),
      );
      const token = await run(remake.findTokenByHash("tenant-a", "token-hash"));
      expect(token?.tokenId).toBe("token-1");
      expect(token?.familyId).toBeUndefined();
      await run(store.revokeToken("tenant-a", "token-1", later));
      const revoked = await run(store.findTokenById("tenant-a", "token-1"));
      expect(revoked?.revokedAt).toEqual(later);

      // Token families: the id round-trips, and revoking a family reaches
      // every live member (access and refresh) and nothing outside it.
      const member = (tokenId: string, familyId: string, kind: "access" | "refresh") =>
        store.putToken({
          tenantId: "tenant-a",
          tokenId,
          kind,
          clientId: "as_client-1",
          userId: "user-1",
          scope: ["mcp:tools"],
          ...(kind === "refresh" ? { tokenHash: `${tokenId}-hash` } : {}),
          familyId,
          expiresAt: later,
          createdAt: at,
        });
      await run(member("fam-a-r1", "family-a", "refresh"));
      await run(member("fam-a-a2", "family-a", "access"));
      await run(member("fam-a-r2", "family-a", "refresh"));
      await run(member("fam-b-r1", "family-b", "refresh"));
      expect((await run(remake.findTokenById("tenant-a", "fam-a-a2")))?.familyId).toBe("family-a");
      await run(store.revokeFamily("tenant-a", "family-a", later));
      for (const tokenId of ["fam-a-r1", "fam-a-a2", "fam-a-r2"]) {
        expect((await run(remake.findTokenById("tenant-a", tokenId)))?.revokedAt).toEqual(later);
      }
      expect((await run(remake.findTokenById("tenant-a", "fam-b-r1")))?.revokedAt).toBeUndefined();
      await run(store.revokeFamily("tenant-b", "family-b", later));
      expect((await run(remake.findTokenById("tenant-a", "fam-b-r1")))?.revokedAt).toBeUndefined();

      await run(
        store.putEndSessionHint({
          tenantId: "tenant-a",
          hintHash: "hint-hash",
          expiresAt: later,
        }),
      );
      expect(
        (await run(remake.consumeEndSessionHint("tenant-a", "hint-hash", now)))?.hintHash,
      ).toBe("hint-hash");
      expect(await run(store.consumeEndSessionHint("tenant-a", "hint-hash", now))).toBeUndefined();
    } finally {
      await harnessClose(harness);
    }
  });
};

const harnessClose = async (harness: OAuthServerHarness): Promise<void> => {
  await (harness as unknown as { readonly close?: () => Promise<void> }).close?.();
};
