import { Effect } from "effect";
import { type AuthStoreError, IdentityConflict } from "./errors.js";
import type {
  AuthUser,
  OAuthIdentity,
  OAuthProviderId,
  OAuthStateRecord,
  OneTimeTokenPurpose,
  OneTimeTokenRecord,
  PasskeyChallengePurpose,
  PasskeyChallengeRecord,
  PasskeyRecord,
  PasswordCredential,
  SessionRecord,
  TenantId,
  TotpRecord,
  UserId,
} from "./model.js";

type StoreEffect<A> = Effect.Effect<A, AuthStoreError | IdentityConflict>;

export interface AuthStore {
  readonly createPasswordUser: (
    user: AuthUser,
    credential: PasswordCredential,
  ) => StoreEffect<void>;
  readonly createOAuthUser: (user: AuthUser, identity: OAuthIdentity) => StoreEffect<void>;
  readonly createMagicLinkUser: (user: AuthUser) => StoreEffect<void>;
  readonly findUserById: (tenantId: TenantId, userId: UserId) => StoreEffect<AuthUser | undefined>;
  readonly findUserByEmail: (
    tenantId: TenantId,
    email: string,
  ) => StoreEffect<AuthUser | undefined>;
  readonly findPassword: (
    tenantId: TenantId,
    email: string,
  ) => StoreEffect<PasswordCredential | undefined>;
  readonly setEmailVerified: (
    tenantId: TenantId,
    userId: UserId,
    now: Date,
  ) => StoreEffect<AuthUser | undefined>;
  readonly replacePasswordAndRevokeSessions: (
    tenantId: TenantId,
    userId: UserId,
    passwordHash: string,
    now: Date,
  ) => StoreEffect<void>;
  readonly putOneTimeToken: (record: OneTimeTokenRecord) => StoreEffect<void>;
  readonly consumeOneTimeToken: (
    tenantId: TenantId,
    purpose: OneTimeTokenPurpose,
    tokenHash: string,
    now: Date,
  ) => StoreEffect<OneTimeTokenRecord | undefined>;
  readonly createSession: (record: SessionRecord) => StoreEffect<void>;
  readonly findSession: (
    tenantId: TenantId,
    tokenHash: string,
    now: Date,
  ) => StoreEffect<SessionRecord | undefined>;
  readonly revokeSession: (tenantId: TenantId, tokenHash: string) => StoreEffect<void>;
  readonly revokeUserSessions: (tenantId: TenantId, userId: UserId) => StoreEffect<void>;
  readonly putOAuthState: (record: OAuthStateRecord) => StoreEffect<void>;
  readonly consumeOAuthState: (
    tenantId: TenantId,
    stateHash: string,
    now: Date,
  ) => StoreEffect<OAuthStateRecord | undefined>;
  readonly findOAuthIdentity: (
    tenantId: TenantId,
    provider: OAuthProviderId,
    subject: string,
  ) => StoreEffect<OAuthIdentity | undefined>;
  readonly addOAuthIdentity: (identity: OAuthIdentity) => StoreEffect<void>;
  readonly putPasskeyChallenge: (record: PasskeyChallengeRecord) => StoreEffect<void>;
  readonly consumePasskeyChallenge: (
    tenantId: TenantId,
    purpose: PasskeyChallengePurpose,
    challengeHash: string,
    now: Date,
  ) => StoreEffect<PasskeyChallengeRecord | undefined>;
  readonly addPasskey: (record: PasskeyRecord) => StoreEffect<void>;
  readonly findPasskey: (
    tenantId: TenantId,
    credentialId: string,
  ) => StoreEffect<PasskeyRecord | undefined>;
  readonly listPasskeys: (
    tenantId: TenantId,
    userId: UserId,
  ) => StoreEffect<ReadonlyArray<PasskeyRecord>>;
  readonly updatePasskeyCounter: (
    tenantId: TenantId,
    credentialId: string,
    expectedCounter: number,
    counter: number,
  ) => StoreEffect<void>;
  readonly putTotpSecret: (record: TotpRecord) => StoreEffect<void>;
  readonly findTotp: (tenantId: TenantId, userId: UserId) => StoreEffect<TotpRecord | undefined>;
  /** Pending → confirmed, replacing the recovery-code hashes atomically. */
  readonly confirmTotp: (
    tenantId: TenantId,
    userId: UserId,
    recoveryCodeHashes: ReadonlyArray<string>,
    now: Date,
  ) => StoreEffect<TotpRecord | undefined>;
  readonly removeTotp: (tenantId: TenantId, userId: UserId) => StoreEffect<void>;
  /** Counts one failure; locks (and reports) once the threshold is reached. */
  readonly recordTotpFailure: (input: {
    readonly tenantId: TenantId;
    readonly userId: UserId;
    readonly threshold: number;
    readonly cooldownMillis: number;
    readonly now: Date;
  }) => StoreEffect<{ readonly locked: boolean; readonly lockedUntil?: Date }>;
  readonly resetTotpFailures: (tenantId: TenantId, userId: UserId) => StoreEffect<void>;
  /** Single-use: removes the hash when present, reports whether it matched. */
  readonly consumeRecoveryCode: (
    tenantId: TenantId,
    userId: UserId,
    codeHash: string,
  ) => StoreEffect<boolean>;
  readonly elevateSession: (tenantId: TenantId, tokenHash: string, now: Date) => StoreEffect<void>;
}

interface MemoryState {
  readonly users: Map<string, AuthUser>;
  readonly usersByEmail: Map<string, string>;
  readonly passwords: Map<string, PasswordCredential>;
  readonly tokens: Map<string, OneTimeTokenRecord>;
  readonly sessions: Map<string, SessionRecord>;
  readonly oauthStates: Map<string, OAuthStateRecord>;
  readonly oauthIdentities: Map<string, OAuthIdentity>;
  readonly passkeyChallenges: Map<string, PasskeyChallengeRecord>;
  readonly passkeys: Map<string, PasskeyRecord>;
  readonly totp: Map<string, TotpRecord>;
}

export interface InMemoryAuthSnapshot {
  readonly users: ReadonlyArray<AuthUser>;
  readonly passwords: ReadonlyArray<PasswordCredential>;
  readonly tokens: ReadonlyArray<OneTimeTokenRecord>;
  readonly sessions: ReadonlyArray<SessionRecord>;
  readonly oauthStates: ReadonlyArray<OAuthStateRecord>;
  readonly oauthIdentities: ReadonlyArray<OAuthIdentity>;
  readonly passkeyChallenges: ReadonlyArray<PasskeyChallengeRecord>;
  readonly passkeys: ReadonlyArray<PasskeyRecord>;
  readonly totp: ReadonlyArray<TotpRecord>;
}

export interface InMemoryAuthStore {
  readonly store: AuthStore;
  readonly snapshot: () => InMemoryAuthSnapshot;
}

const scoped = (tenantId: string, value: string): string => `${tenantId}\u0000${value}`;
const tokenKey = (tenantId: string, purpose: string, hash: string): string =>
  `${tenantId}\u0000${purpose}\u0000${hash}`;
const oauthKey = (tenantId: string, provider: string, subject: string): string =>
  `${tenantId}\u0000${provider}\u0000${subject}`;

const newState = (): MemoryState => ({
  users: new Map(),
  usersByEmail: new Map(),
  passwords: new Map(),
  tokens: new Map(),
  sessions: new Map(),
  oauthStates: new Map(),
  oauthIdentities: new Map(),
  passkeyChallenges: new Map(),
  passkeys: new Map(),
  totp: new Map(),
});

export const inMemoryAuthStore = (): InMemoryAuthStore => {
  const state = newState();

  const assertUserUnique = (user: AuthUser): IdentityConflict | undefined => {
    if (state.users.has(scoped(user.tenantId, user.id))) {
      return new IdentityConflict({ tenantId: user.tenantId, identity: `user:${user.id}` });
    }
    if (user.email !== undefined && state.usersByEmail.has(scoped(user.tenantId, user.email))) {
      return new IdentityConflict({ tenantId: user.tenantId, identity: "email" });
    }
    return undefined;
  };

  const insertUser = (user: AuthUser): void => {
    state.users.set(scoped(user.tenantId, user.id), user);
    if (user.email !== undefined)
      state.usersByEmail.set(scoped(user.tenantId, user.email), user.id);
  };

  const store: AuthStore = {
    createPasswordUser: (user, credential) =>
      Effect.suspend(() => {
        const conflict = assertUserUnique(user);
        if (conflict !== undefined) return Effect.fail(conflict);
        const passwordKey = scoped(credential.tenantId, credential.email);
        if (state.passwords.has(passwordKey)) {
          return Effect.fail(
            new IdentityConflict({ tenantId: credential.tenantId, identity: "password-email" }),
          );
        }
        insertUser(user);
        state.passwords.set(passwordKey, credential);
        return Effect.void;
      }),
    createOAuthUser: (user, identity) =>
      Effect.suspend(() => {
        const conflict = assertUserUnique(user);
        if (conflict !== undefined) return Effect.fail(conflict);
        const identityKey = oauthKey(identity.tenantId, identity.provider, identity.subject);
        if (state.oauthIdentities.has(identityKey)) {
          return Effect.fail(
            new IdentityConflict({ tenantId: identity.tenantId, identity: "oauth" }),
          );
        }
        insertUser(user);
        state.oauthIdentities.set(identityKey, identity);
        return Effect.void;
      }),
    createMagicLinkUser: (user) =>
      Effect.suspend(() => {
        const conflict = assertUserUnique(user);
        if (conflict !== undefined) return Effect.fail(conflict);
        insertUser(user);
        return Effect.void;
      }),
    findUserById: (tenantId, userId) =>
      Effect.sync(() => state.users.get(scoped(tenantId, userId))),
    findUserByEmail: (tenantId, email) =>
      Effect.sync(() => {
        const userId = state.usersByEmail.get(scoped(tenantId, email));
        return userId === undefined ? undefined : state.users.get(scoped(tenantId, userId));
      }),
    findPassword: (tenantId, email) =>
      Effect.sync(() => state.passwords.get(scoped(tenantId, email))),
    setEmailVerified: (tenantId, userId, now) =>
      Effect.sync(() => {
        const key = scoped(tenantId, userId);
        const current = state.users.get(key);
        if (current === undefined) return undefined;
        const updated = { ...current, emailVerified: true, updatedAt: now };
        state.users.set(key, updated);
        return updated;
      }),
    replacePasswordAndRevokeSessions: (tenantId, userId, passwordHash, now) =>
      Effect.sync(() => {
        for (const [key, credential] of state.passwords) {
          if (credential.tenantId === tenantId && credential.userId === userId) {
            state.passwords.set(key, { ...credential, passwordHash, updatedAt: now });
          }
        }
        for (const [key, session] of state.sessions) {
          if (session.tenantId === tenantId && session.userId === userId)
            state.sessions.delete(key);
        }
      }),
    putOneTimeToken: (record) =>
      Effect.sync(() => {
        for (const [key, existing] of state.tokens) {
          if (
            existing.tenantId === record.tenantId &&
            existing.purpose === record.purpose &&
            existing.email === record.email
          ) {
            state.tokens.delete(key);
          }
        }
        state.tokens.set(tokenKey(record.tenantId, record.purpose, record.tokenHash), record);
      }),
    consumeOneTimeToken: (tenantId, purpose, hash, now) =>
      Effect.sync(() => {
        const key = tokenKey(tenantId, purpose, hash);
        const record = state.tokens.get(key);
        state.tokens.delete(key);
        return record === undefined || record.expiresAt.getTime() <= now.getTime()
          ? undefined
          : record;
      }),
    createSession: (record) =>
      Effect.suspend(() => {
        const key = scoped(record.tenantId, record.tokenHash);
        if (state.sessions.has(key)) {
          return Effect.fail(
            new IdentityConflict({ tenantId: record.tenantId, identity: "session-token" }),
          );
        }
        state.sessions.set(key, record);
        return Effect.void;
      }),
    findSession: (tenantId, hash, now) =>
      Effect.sync(() => {
        const key = scoped(tenantId, hash);
        const record = state.sessions.get(key);
        if (record !== undefined && record.expiresAt.getTime() <= now.getTime()) {
          state.sessions.delete(key);
          return undefined;
        }
        return record;
      }),
    revokeSession: (tenantId, hash) =>
      Effect.sync(() => {
        state.sessions.delete(scoped(tenantId, hash));
      }),
    revokeUserSessions: (tenantId, userId) =>
      Effect.sync(() => {
        for (const [key, session] of state.sessions) {
          if (session.tenantId === tenantId && session.userId === userId)
            state.sessions.delete(key);
        }
      }),
    putOAuthState: (record) =>
      Effect.sync(() => {
        state.oauthStates.set(scoped(record.tenantId, record.stateHash), record);
      }),
    consumeOAuthState: (tenantId, hash, now) =>
      Effect.sync(() => {
        const key = scoped(tenantId, hash);
        const record = state.oauthStates.get(key);
        state.oauthStates.delete(key);
        return record === undefined || record.expiresAt.getTime() <= now.getTime()
          ? undefined
          : record;
      }),
    findOAuthIdentity: (tenantId, provider, subject) =>
      Effect.sync(() => state.oauthIdentities.get(oauthKey(tenantId, provider, subject))),
    addOAuthIdentity: (identity) =>
      Effect.suspend(() => {
        const key = oauthKey(identity.tenantId, identity.provider, identity.subject);
        if (state.oauthIdentities.has(key)) {
          return Effect.fail(
            new IdentityConflict({ tenantId: identity.tenantId, identity: "oauth" }),
          );
        }
        state.oauthIdentities.set(key, identity);
        return Effect.void;
      }),
    putPasskeyChallenge: (record) =>
      Effect.sync(() => {
        state.passkeyChallenges.set(
          tokenKey(record.tenantId, record.purpose, record.challengeHash),
          record,
        );
      }),
    consumePasskeyChallenge: (tenantId, purpose, hash, now) =>
      Effect.sync(() => {
        const key = tokenKey(tenantId, purpose, hash);
        const record = state.passkeyChallenges.get(key);
        state.passkeyChallenges.delete(key);
        return record === undefined || record.expiresAt.getTime() <= now.getTime()
          ? undefined
          : record;
      }),
    addPasskey: (record) =>
      Effect.suspend(() => {
        const key = scoped(record.tenantId, record.credentialId);
        if (state.passkeys.has(key)) {
          return Effect.fail(
            new IdentityConflict({ tenantId: record.tenantId, identity: "passkey" }),
          );
        }
        state.passkeys.set(key, record);
        return Effect.void;
      }),
    findPasskey: (tenantId, credentialId) =>
      Effect.sync(() => state.passkeys.get(scoped(tenantId, credentialId))),
    listPasskeys: (tenantId, userId) =>
      Effect.sync(() =>
        [...state.passkeys.values()].filter(
          (passkey) => passkey.tenantId === tenantId && passkey.userId === userId,
        ),
      ),
    updatePasskeyCounter: (tenantId, credentialId, expectedCounter, counter) =>
      Effect.suspend(() => {
        const key = scoped(tenantId, credentialId);
        const current = state.passkeys.get(key);
        if (current === undefined || current.counter !== expectedCounter) {
          return Effect.fail(new IdentityConflict({ tenantId, identity: "passkey-counter" }));
        }
        state.passkeys.set(key, { ...current, counter });
        return Effect.void;
      }),
    putTotpSecret: (record) =>
      Effect.sync(() => {
        state.totp.set(scoped(record.tenantId, record.userId), record);
      }),
    findTotp: (tenantId, userId) => Effect.sync(() => state.totp.get(scoped(tenantId, userId))),
    confirmTotp: (tenantId, userId, recoveryCodeHashes, now) =>
      Effect.sync(() => {
        const key = scoped(tenantId, userId);
        const current = state.totp.get(key);
        if (current === undefined || current.confirmed) return undefined;
        const updated: TotpRecord = {
          ...current,
          confirmed: true,
          recoveryCodeHashes: [...recoveryCodeHashes],
          failedAttempts: 0,
          enrolledAt: now,
        };
        state.totp.set(key, updated);
        return updated;
      }),
    removeTotp: (tenantId, userId) =>
      Effect.sync(() => {
        state.totp.delete(scoped(tenantId, userId));
      }),
    recordTotpFailure: ({ tenantId, userId, threshold, cooldownMillis, now }) =>
      Effect.sync(() => {
        const key = scoped(tenantId, userId);
        const current = state.totp.get(key);
        if (current === undefined) return { locked: false as const };
        const failedAttempts = current.failedAttempts + 1;
        const locked = failedAttempts >= threshold;
        const lockedUntil = locked ? new Date(now.getTime() + cooldownMillis) : current.lockedUntil;
        state.totp.set(key, {
          ...current,
          failedAttempts,
          ...(lockedUntil === undefined ? {} : { lockedUntil }),
        });
        return locked
          ? { locked: true as const, lockedUntil: lockedUntil as Date }
          : { locked: false as const };
      }),
    resetTotpFailures: (tenantId, userId) =>
      Effect.sync(() => {
        const key = scoped(tenantId, userId);
        const current = state.totp.get(key);
        if (current !== undefined) {
          const { lockedUntil: _expired, ...rest } = current;
          state.totp.set(key, { ...rest, failedAttempts: 0 });
        }
      }),
    consumeRecoveryCode: (tenantId, userId, codeHash) =>
      Effect.sync(() => {
        const key = scoped(tenantId, userId);
        const current = state.totp.get(key);
        if (current === undefined || !current.recoveryCodeHashes.includes(codeHash)) {
          return false;
        }
        state.totp.set(key, {
          ...current,
          recoveryCodeHashes: current.recoveryCodeHashes.filter((hash) => hash !== codeHash),
        });
        return true;
      }),
    elevateSession: (tenantId, tokenHash, now) =>
      Effect.sync(() => {
        const key = scoped(tenantId, tokenHash);
        const session = state.sessions.get(key);
        if (session !== undefined) {
          state.sessions.set(key, { ...session, elevatedAt: now });
        }
      }),
  };

  return {
    store,
    snapshot: () => ({
      users: [...state.users.values()],
      passwords: [...state.passwords.values()],
      tokens: [...state.tokens.values()],
      sessions: [...state.sessions.values()],
      oauthStates: [...state.oauthStates.values()],
      oauthIdentities: [...state.oauthIdentities.values()],
      passkeyChallenges: [...state.passkeyChallenges.values()],
      passkeys: [...state.passkeys.values()],
      totp: [...state.totp.values()],
    }),
  };
};
