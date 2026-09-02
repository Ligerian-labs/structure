import { expect, test } from "bun:test";
import {
  type ApiKeyRecord,
  type ApiKeyStore,
  type AuthStore,
  type AuthUser,
  IdentityConflict,
  type OAuthStateRecord,
  type PasskeyRecord,
  type PasswordCredential,
  type SessionRecord,
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
