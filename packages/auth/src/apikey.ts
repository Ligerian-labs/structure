import { Effect, Redacted } from "effect";
import { AuthDependencyError, type AuthStoreError, InvalidCredentials } from "./errors.js";
import type { TenantId, UserId } from "./model.js";

/** A machine credential: opaque id + secret, hashed against a versioned pepper. */
export interface ApiKeyRecord {
  readonly tenantId: TenantId;
  readonly keyId: string;
  readonly userId: UserId;
  readonly name?: string;
  /** Scope allowlist (e.g. `data:export`) — the only powers this key holds. */
  readonly scopes: ReadonlyArray<string>;
  /** HMAC-SHA256(pepper[version], secret) in base64url. Never the raw secret. */
  readonly secretHash: string;
  readonly pepperVersion: number;
  /** Optional workspace pin: the key answers only within this workspace. */
  readonly workspaceId?: string;
  readonly expiresAt?: Date;
  readonly createdAt: Date;
  readonly lastUsedAt?: Date;
  readonly revokedAt?: Date;
}

/** Minted once, at creation: the only time the raw key exists in cleartext. */
export interface MintedApiKey {
  /** `sk_<keyId>_<pepperVersion>_<secret>` — show it once, store only the hash. */
  readonly key: Redacted.Redacted<string>;
  readonly record: ApiKeyRecord;
}

export interface ApiKeyStore {
  readonly create: (record: ApiKeyRecord) => Effect.Effect<void, AuthStoreError>;
  readonly findByKeyId: (
    tenantId: TenantId,
    keyId: string,
  ) => Effect.Effect<ApiKeyRecord | undefined, AuthStoreError>;
  /** Marks last-use; cheap, idempotent, never blocks verification semantics. */
  readonly markUsed: (
    tenantId: TenantId,
    keyId: string,
    now: Date,
  ) => Effect.Effect<void, AuthStoreError>;
  /** Lazy pepper rotation: swap the hash and its pepper version atomically. */
  readonly replaceHash: (
    tenantId: TenantId,
    keyId: string,
    secretHash: string,
    pepperVersion: number,
  ) => Effect.Effect<void, AuthStoreError>;
  readonly revoke: (
    tenantId: TenantId,
    keyId: string,
    now: Date,
  ) => Effect.Effect<void, AuthStoreError>;
  readonly listByUser: (
    tenantId: TenantId,
    userId: UserId,
  ) => Effect.Effect<ReadonlyArray<ApiKeyRecord>, AuthStoreError>;
}

/** The standing an authenticated key grants — feed to `@structure-ai/authorization`. */
export interface ApiKeyStanding {
  readonly userId: UserId;
  readonly tenantId: TenantId;
  readonly keyId: string;
  readonly scopes: ReadonlyArray<string>;
  readonly workspaceId?: string;
  /**
   * A restricted machine principal: `kind: "service"`, no roles, scopes and
   * workspace pinned as attributes. Unlisted routes deny (fail-closed) in
   * policies that gate machine principals on scope attributes.
   */
  readonly principal: {
    readonly id: string;
    readonly kind: "service";
    readonly roles: ReadonlyArray<string>;
    readonly tenantId: TenantId;
    readonly attributes: Readonly<Record<string, unknown>>;
  };
}

/** Versioned pepper set: `current` mints and rehashes; retired versions only verify. */
export interface ApiKeyPeppers {
  readonly current: { readonly version: number; readonly pepper: Redacted.Redacted<string> };
  readonly retired: ReadonlyArray<{
    readonly version: number;
    readonly pepper: Redacted.Redacted<string>;
  }>;
}

const SECRET_BYTES = 32;
const KEY_ID_BYTES = 12;
const KEY_PREFIX = "sk";

const encoder = new TextEncoder();

const hmacSha256 = (pepper: string, value: string): Effect.Effect<string, AuthDependencyError> =>
  Effect.promise(() =>
    crypto.subtle
      .importKey("raw", encoder.encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
      .then((key) => crypto.subtle.sign("HMAC", key, encoder.encode(value)))
      .then((digest) => Buffer.from(digest).toString("base64url")),
  ).pipe(
    Effect.mapError(
      (cause): AuthDependencyError =>
        new AuthDependencyError({ dependency: "hmac-sha256", operation: "sign", cause }),
    ),
  );

/** Constant-time comparison of two equal-length strings. */
const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
};

/** Hex alphabet: no `_`, so the secret can never split the key format. */
const randomHex = (bytes: number): string => {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Buffer.from(buffer).toString("hex");
};

const pepperFor = (
  peppers: ApiKeyPeppers,
  version: number,
): Redacted.Redacted<string> | undefined =>
  [peppers.current, ...peppers.retired].find((entry) => entry.version === version)?.pepper;

export interface MakeApiKeysOptions {
  readonly store: ApiKeyStore;
  readonly peppers: ApiKeyPeppers;
  /** Resolves whether the owning user still stands (exists, live membership). */
  readonly resolveUser?: (
    tenantId: TenantId,
    userId: UserId,
  ) => Effect.Effect<boolean, AuthDependencyError>;
  readonly now?: () => Date;
}

export interface MintApiKeyInput {
  readonly userId: UserId;
  readonly name?: string;
  readonly scopes: ReadonlyArray<string>;
  readonly workspaceId?: string;
  readonly expiresAt?: Date;
}

export interface ApiKeys {
  readonly mint: (
    tenantId: TenantId,
    input: MintApiKeyInput,
  ) => Effect.Effect<MintedApiKey, ApiKeyServiceError>;
  readonly verify: (
    tenantId: TenantId,
    rawKey: Redacted.Redacted<string>,
  ) => Effect.Effect<ApiKeyStanding, ApiKeyServiceError>;
  readonly revoke: (tenantId: TenantId, keyId: string) => Effect.Effect<void, ApiKeyServiceError>;
  readonly listByUser: (
    tenantId: TenantId,
    userId: UserId,
  ) => Effect.Effect<ReadonlyArray<ApiKeyRecord>, ApiKeyServiceError>;
}

export type ApiKeyServiceError = AuthDependencyError | AuthStoreError | InvalidCredentials;

/** In-memory `ApiKeyStore` for tests and development. */
export const inMemoryApiKeyStore = (): ApiKeyStore & {
  readonly snapshot: () => ReadonlyArray<ApiKeyRecord>;
} => {
  const records = new Map<string, ApiKeyRecord>();
  const scoped = (tenantId: string, keyId: string): string => `${tenantId}\u0000${keyId}`;
  return {
    create: (record) =>
      Effect.sync(() => {
        records.set(scoped(record.tenantId, record.keyId), record);
      }),
    findByKeyId: (tenantId, keyId) => Effect.sync(() => records.get(scoped(tenantId, keyId))),
    markUsed: (tenantId, keyId, at) =>
      Effect.sync(() => {
        const key = scoped(tenantId, keyId);
        const current = records.get(key);
        if (current !== undefined) records.set(key, { ...current, lastUsedAt: at });
      }),
    replaceHash: (tenantId, keyId, secretHash, pepperVersion) =>
      Effect.sync(() => {
        const key = scoped(tenantId, keyId);
        const current = records.get(key);
        if (current !== undefined) {
          records.set(key, { ...current, secretHash, pepperVersion });
        }
      }),
    revoke: (tenantId, keyId, at) =>
      Effect.sync(() => {
        const key = scoped(tenantId, keyId);
        const current = records.get(key);
        if (current !== undefined) records.set(key, { ...current, revokedAt: at });
      }),
    listByUser: (tenantId, userId) =>
      Effect.sync(() =>
        [...records.values()].filter(
          (record) => record.tenantId === tenantId && record.userId === userId,
        ),
      ),
    snapshot: () => [...records.values()],
  };
};

export const makeApiKeys = (options: MakeApiKeysOptions): ApiKeys => {
  const now = options.now ?? (() => new Date());

  const parseKey = (
    raw: string,
  ): { keyId: string; version: number; secret: string } | InvalidCredentials => {
    const parts = raw.split("_");
    if (parts.length !== 4 || parts[0] !== KEY_PREFIX) {
      return new InvalidCredentials({ reason: "api-key-shape" });
    }
    const keyId = parts[1] ?? "";
    const version = Number(parts[2]);
    const secret = parts[3] ?? "";
    if (keyId.length === 0 || secret.length < 32 || !Number.isInteger(version) || version < 1) {
      return new InvalidCredentials({ reason: "api-key-shape" });
    }
    return { keyId, version, secret };
  };

  return {
    mint: (tenantId, input) =>
      Effect.gen(function* () {
        const keyId = randomHex(KEY_ID_BYTES);
        const secret = randomHex(SECRET_BYTES);
        const secretHash = yield* hmacSha256(
          Redacted.value(options.peppers.current.pepper),
          secret,
        );
        const record: ApiKeyRecord = {
          tenantId,
          keyId,
          userId: input.userId,
          ...(input.name === undefined ? {} : { name: input.name }),
          scopes: [...input.scopes],
          secretHash,
          pepperVersion: options.peppers.current.version,
          ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
          ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
          createdAt: now(),
        };
        yield* options.store.create(record);
        return {
          key: Redacted.make(`${KEY_PREFIX}_${keyId}_${options.peppers.current.version}_${secret}`),
          record,
        };
      }),
    verify: (tenantId, rawKey) =>
      Effect.gen(function* () {
        const parsed = parseKey(Redacted.value(rawKey));
        if (parsed instanceof InvalidCredentials) return yield* parsed;
        const record = yield* options.store.findByKeyId(tenantId, parsed.keyId);
        if (record === undefined) return yield* new InvalidCredentials({ reason: "api-key" });
        if (record.revokedAt !== undefined) {
          return yield* new InvalidCredentials({ reason: "api-key-revoked" });
        }
        if (record.expiresAt !== undefined && record.expiresAt.getTime() <= now().getTime()) {
          return yield* new InvalidCredentials({ reason: "api-key-expired" });
        }
        // A dead owning user fails with 401 before any workspace/scope answer.
        if (options.resolveUser !== undefined) {
          const alive = yield* options.resolveUser(tenantId, record.userId);
          if (!alive) return yield* new InvalidCredentials({ reason: "api-key-user" });
        }
        const pepper = pepperFor(options.peppers, record.pepperVersion);
        if (pepper === undefined) {
          // Hashed under a retired pepper that is no longer known: reject.
          return yield* new InvalidCredentials({ reason: "api-key-pepper-retired" });
        }
        const candidateHash = yield* hmacSha256(Redacted.value(pepper), parsed.secret);
        if (!timingSafeEqual(candidateHash, record.secretHash)) {
          return yield* new InvalidCredentials({ reason: "api-key" });
        }
        // Lazy pepper rotation: first successful use under an old pepper rehashes.
        if (record.pepperVersion !== options.peppers.current.version) {
          const rehashed = yield* hmacSha256(
            Redacted.value(options.peppers.current.pepper),
            parsed.secret,
          );
          yield* options.store.replaceHash(
            tenantId,
            record.keyId,
            rehashed,
            options.peppers.current.version,
          );
        }
        yield* options.store.markUsed(tenantId, record.keyId, now());
        return {
          userId: record.userId,
          tenantId,
          keyId: record.keyId,
          scopes: record.scopes,
          ...(record.workspaceId === undefined ? {} : { workspaceId: record.workspaceId }),
          principal: {
            id: `apikey:${record.keyId}`,
            kind: "service" as const,
            // Apps define a "machine" role granting only scope-conditioned
            // permissions; anything unlisted stays ungranted (fail-closed).
            roles: ["machine"],
            tenantId,
            attributes: {
              apiKeyId: record.keyId,
              scopes: [...record.scopes],
              ...(record.workspaceId === undefined ? {} : { workspaceId: record.workspaceId }),
            },
          },
        };
      }),
    revoke: (tenantId, keyId) =>
      options.store.revoke(tenantId, keyId, now()) as Effect.Effect<void, ApiKeyServiceError>,
    listByUser: (tenantId, userId) =>
      options.store.listByUser(tenantId, userId) as Effect.Effect<
        ReadonlyArray<ApiKeyRecord>,
        ApiKeyServiceError
      >,
  };
};
