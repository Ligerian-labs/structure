import { Effect, Redacted } from "effect";
import { decodeBase64Url, encodeBase64Url, randomToken, sha256 } from "./crypto.js";
import {
  AuthDependencyError,
  type AuthStoreError,
  AuthValidationError,
  InvalidAuthToken,
  InvalidCredentials,
} from "./errors.js";
import type { TenantId, UserId } from "./model.js";
import { type AuthAuditSink, noOpAuthAuditSink } from "./ports.js";

// --- model -------------------------------------------------------------------------

export interface OAuthClientRecord {
  readonly tenantId: TenantId;
  readonly clientId: string;
  readonly clientName?: string;
  readonly clientType: "confidential" | "public";
  /** Confidential clients only: SHA-256 of the secret (never the secret). */
  readonly secretHash?: string;
  readonly redirectUris: ReadonlyArray<string>;
  /** The complete scope vocabulary this client may ask for. */
  readonly scopes: ReadonlyArray<string>;
  readonly createdAt: Date;
}

export interface MintedClient {
  /** Confidential clients: the raw secret, shown exactly once. */
  readonly clientSecret?: Redacted.Redacted<string>;
  readonly record: OAuthClientRecord;
}

export type OAuthServerScope = string;

export interface AuthorizationRequest {
  readonly tenantId: TenantId;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scope: ReadonlyArray<OAuthServerScope>;
  readonly state?: string;
  readonly codeChallenge: string;
  /** Only S256 is accepted; plain PKCE is refused. */
  readonly codeChallengeMethod: string;
}

export interface IssuedTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly tokenType: "Bearer";
  readonly expiresIn: number;
  readonly scope: ReadonlyArray<OAuthServerScope>;
}

export interface TokenIntrospection {
  readonly active: boolean;
  readonly scope?: string;
  readonly clientId?: string;
  readonly userId?: string;
  readonly expiresAt?: Date;
  readonly revokedAt?: Date;
}

/** One asymmetric signing key (RS256); rotation keeps the previous one verifying. */
export interface OAuthSigningKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  /** Public JWK exactly as published in the JWKS. */
  readonly publicJwk: Record<string, unknown>;
  /**
   * The verifying half. Optional: when absent (a key restored from storage
   * as private key + JWK) it is imported from `publicJwk` on first use.
   */
  readonly publicKey?: CryptoKey;
}

export interface OAuthSigningKeys {
  readonly current: OAuthSigningKey;
  readonly previous?: OAuthSigningKey;
}

/** Generates a fresh RS256 signing key pair with a random `kid`. */
export const generateSigningKey = (): Effect.Effect<OAuthSigningKey, AuthDependencyError> =>
  Effect.tryPromise({
    try: async () => {
      const pair = await crypto.subtle.generateKey(
        {
          name: "RSASSA-PKCS1-v1_5",
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        true,
        ["sign", "verify"],
      );
      const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as Record<string, unknown>;
      const { d, p, q, dp, dq, qi, ...publicJwk } = jwk;
      void d;
      void p;
      void q;
      void dp;
      void dq;
      void qi;
      return {
        kid: randomToken(8),
        privateKey: pair.privateKey,
        publicJwk,
        publicKey: pair.publicKey,
      };
    },
    catch: (cause) =>
      new AuthDependencyError({ dependency: "rsa", operation: "generate-signing-key", cause }),
  });

// --- store port ----------------------------------------------------------------------

export interface AuthorizationCodeRecord {
  readonly tenantId: TenantId;
  readonly codeHash: string;
  readonly clientId: string;
  readonly userId: UserId;
  readonly redirectUri: string;
  readonly scope: ReadonlyArray<OAuthServerScope>;
  readonly codeChallenge: string;
  readonly expiresAt: Date;
  readonly consumedAt?: Date;
}

export interface OAuthTokenRecord {
  readonly tenantId: TenantId;
  readonly tokenId: string;
  readonly kind: "access" | "refresh";
  readonly clientId: string;
  readonly userId?: UserId;
  readonly scope: ReadonlyArray<OAuthServerScope>;
  /** Hash for opaque tokens (refresh); absent for self-contained JWTs. */
  readonly tokenHash?: string;
  /**
   * The grant this token descends from: set at code exchange and carried
   * through every refresh rotation, so reuse of a rotated-away refresh token
   * revokes the whole family. Absent on records minted before families
   * existed; such a record roots a family under its own `tokenId` when it
   * is next refreshed.
   */
  readonly familyId?: string;
  readonly expiresAt: Date;
  readonly revokedAt?: Date;
  readonly createdAt: Date;
}

export interface ConsentRecord {
  readonly tenantId: TenantId;
  readonly clientId: string;
  readonly userId: UserId;
  readonly scope: ReadonlyArray<OAuthServerScope>;
  readonly grantedAt: Date;
}

export interface EndSessionHintRecord {
  readonly tenantId: TenantId;
  readonly hintHash: string;
  readonly expiresAt: Date;
  readonly consumedAt?: Date;
}

/**
 * Durable state of the authorization server. Consumption methods must be
 * atomic (single-use codes, single-use end-session hints, rotated refresh
 * tokens).
 */
export interface OAuthServerStore {
  readonly putClient: (record: OAuthClientRecord) => Effect.Effect<void, AuthStoreError>;
  readonly findClient: (
    tenantId: TenantId,
    clientId: string,
  ) => Effect.Effect<OAuthClientRecord | undefined, AuthStoreError>;
  readonly putAuthorizationCode: (
    record: AuthorizationCodeRecord,
  ) => Effect.Effect<void, AuthStoreError>;
  /** Single-use: returns and marks consumed atomically; replays get `undefined`. */
  readonly consumeAuthorizationCode: (
    tenantId: TenantId,
    codeHash: string,
    now: Date,
  ) => Effect.Effect<AuthorizationCodeRecord | undefined, AuthStoreError>;
  readonly findConsent: (
    tenantId: TenantId,
    clientId: string,
    userId: UserId,
  ) => Effect.Effect<ConsentRecord | undefined, AuthStoreError>;
  readonly putConsent: (record: ConsentRecord) => Effect.Effect<void, AuthStoreError>;
  readonly putToken: (record: OAuthTokenRecord) => Effect.Effect<void, AuthStoreError>;
  readonly findTokenByHash: (
    tenantId: TenantId,
    tokenHash: string,
  ) => Effect.Effect<OAuthTokenRecord | undefined, AuthStoreError>;
  readonly findTokenById: (
    tenantId: TenantId,
    tokenId: string,
  ) => Effect.Effect<OAuthTokenRecord | undefined, AuthStoreError>;
  readonly revokeToken: (
    tenantId: TenantId,
    tokenId: string,
    now: Date,
  ) => Effect.Effect<void, AuthStoreError>;
  /** Revokes every live token of a family (access and refresh alike). */
  readonly revokeFamily: (
    tenantId: TenantId,
    familyId: string,
    now: Date,
  ) => Effect.Effect<void, AuthStoreError>;
  readonly putEndSessionHint: (record: EndSessionHintRecord) => Effect.Effect<void, AuthStoreError>;
  readonly consumeEndSessionHint: (
    tenantId: TenantId,
    hintHash: string,
    now: Date,
  ) => Effect.Effect<EndSessionHintRecord | undefined, AuthStoreError>;
}

/** In-memory `OAuthServerStore` for tests and development. */
export const inMemoryOAuthServerStore = (): OAuthServerStore & {
  readonly snapshot: () => {
    readonly clients: ReadonlyArray<OAuthClientRecord>;
    readonly tokens: ReadonlyArray<OAuthTokenRecord>;
    readonly codes: ReadonlyArray<AuthorizationCodeRecord>;
    readonly consents: ReadonlyArray<ConsentRecord>;
  };
} => {
  const clients = new Map<string, OAuthClientRecord>();
  const codes = new Map<string, AuthorizationCodeRecord>();
  const consents = new Map<string, ConsentRecord>();
  const tokens = new Map<string, OAuthTokenRecord>();
  const hints = new Map<string, EndSessionHintRecord>();
  const scoped = (tenantId: string, value: string): string => `${tenantId}\u0000${value}`;
  return {
    putClient: (record) =>
      Effect.sync(() => {
        clients.set(scoped(record.tenantId, record.clientId), record);
      }),
    findClient: (tenantId, clientId) => Effect.sync(() => clients.get(scoped(tenantId, clientId))),
    putAuthorizationCode: (record) =>
      Effect.sync(() => {
        codes.set(scoped(record.tenantId, record.codeHash), record);
      }),
    consumeAuthorizationCode: (tenantId, codeHash, now) =>
      Effect.sync(() => {
        const key = scoped(tenantId, codeHash);
        const record = codes.get(key);
        if (record === undefined) return undefined;
        if (record.consumedAt !== undefined || record.expiresAt.getTime() <= now.getTime()) {
          return undefined;
        }
        codes.set(key, { ...record, consumedAt: now });
        return record;
      }),
    findConsent: (tenantId, clientId, userId) =>
      Effect.sync(() => consents.get(scoped(tenantId, `${clientId}\u0000${userId}`))),
    putConsent: (record) =>
      Effect.sync(() => {
        consents.set(scoped(record.tenantId, `${record.clientId}\u0000${record.userId}`), record);
      }),
    putToken: (record) =>
      Effect.sync(() => {
        tokens.set(scoped(record.tenantId, record.tokenId), record);
      }),
    findTokenByHash: (tenantId, tokenHash) =>
      Effect.sync(() => {
        for (const token of tokens.values()) {
          if (token.tenantId === tenantId && token.tokenHash === tokenHash) return token;
        }
        return undefined;
      }),
    findTokenById: (tenantId, tokenId) => Effect.sync(() => tokens.get(scoped(tenantId, tokenId))),
    revokeToken: (tenantId, tokenId, now) =>
      Effect.sync(() => {
        const key = scoped(tenantId, tokenId);
        const current = tokens.get(key);
        if (current !== undefined) tokens.set(key, { ...current, revokedAt: now });
      }),
    revokeFamily: (tenantId, familyId, now) =>
      Effect.sync(() => {
        for (const [key, token] of tokens) {
          if (
            token.tenantId === tenantId &&
            token.familyId === familyId &&
            token.revokedAt === undefined
          ) {
            tokens.set(key, { ...token, revokedAt: now });
          }
        }
      }),
    putEndSessionHint: (record) =>
      Effect.sync(() => {
        hints.set(scoped(record.tenantId, record.hintHash), record);
      }),
    consumeEndSessionHint: (tenantId, hintHash, now) =>
      Effect.sync(() => {
        const key = scoped(tenantId, hintHash);
        const record = hints.get(key);
        if (record === undefined) return undefined;
        if (record.consumedAt !== undefined || record.expiresAt.getTime() <= now.getTime()) {
          return undefined;
        }
        hints.set(key, { ...record, consumedAt: now });
        return record;
      }),
    snapshot: () => ({
      clients: [...clients.values()],
      tokens: [...tokens.values()],
      codes: [...codes.values()],
      consents: [...consents.values()],
    }),
  };
};

// --- service --------------------------------------------------------------------------

export interface AuthorizationServerOptions {
  readonly store: OAuthServerStore;
  readonly resolveTenant: (
    tenantId: TenantId,
  ) => Effect.Effect<{ readonly baseUrl: URL }, AuthDependencyError | AuthValidationError>;
  readonly signingKeys: OAuthSigningKeys;
  /**
   * Registration gates — env switches, never code removal. Both closed by
   * default: `registerClient` fails until a gate is explicitly opened.
   */
  readonly registration?: {
    /** Anonymous RFC 7591 dynamic registration. Default: closed. */
    readonly anonymous?: boolean;
    /** Signed-in management surface. Default: closed. */
    readonly signedIn?: boolean;
  };
  readonly accessTokenTtlMillis?: number;
  readonly refreshTokenTtlMillis?: number;
  readonly codeTtlMillis?: number;
  /** Bounded grace for end-session hints. Default 5 minutes. */
  readonly endSessionHintTtlMillis?: number;
  /** Receives `oauth-refresh-reuse` when a rotated-away refresh token is presented. */
  readonly audit?: AuthAuditSink;
  readonly primitives?: Partial<{
    readonly now: () => Date;
    readonly randomToken: (byteLength?: number) => string;
    readonly hashToken: (token: string) => Effect.Effect<string, AuthDependencyError>;
  }>;
}

export interface RegisterClientInput {
  readonly clientName?: string;
  readonly clientType: "confidential" | "public";
  readonly redirectUris: ReadonlyArray<string>;
  readonly scopes: ReadonlyArray<OAuthServerScope>;
}

export type AuthorizationDecision =
  | { readonly redirectUrl: string }
  | { readonly consentRequired: true; readonly state?: string };

export interface GrantConsentInput {
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly clientId: string;
  readonly scope: ReadonlyArray<OAuthServerScope>;
}

export interface AccessTokenClaims {
  readonly iss: string;
  readonly sub: UserId;
  readonly aud: string;
  readonly scope: string;
  readonly jti: string;
  readonly exp: number;
  readonly iat: number;
  readonly tenantId: TenantId;
}

export interface AuthorizationServer {
  readonly registerClient: (
    tenantId: TenantId,
    input: RegisterClientInput,
    context:
      | { readonly kind: "anonymous" }
      | { readonly kind: "signed-in"; readonly userId: UserId },
  ) => Effect.Effect<MintedClient, AuthDependencyError | AuthValidationError | AuthStoreError>;
  readonly authorize: (
    request: AuthorizationRequest,
    userId: UserId,
  ) => Effect.Effect<
    AuthorizationDecision,
    AuthDependencyError | AuthValidationError | AuthStoreError
  >;
  readonly grantConsent: (
    input: GrantConsentInput,
  ) => Effect.Effect<void, AuthDependencyError | AuthValidationError | AuthStoreError>;
  readonly exchangeCode: (input: {
    readonly tenantId: TenantId;
    readonly clientId: string;
    readonly clientSecret?: Redacted.Redacted<string>;
    readonly code: Redacted.Redacted<string>;
    readonly codeVerifier: string;
    readonly redirectUri: string;
  }) => Effect.Effect<
    IssuedTokens,
    | AuthDependencyError
    | InvalidAuthToken
    | InvalidCredentials
    | AuthValidationError
    | AuthStoreError
  >;
  readonly refresh: (input: {
    readonly tenantId: TenantId;
    readonly clientId: string;
    readonly clientSecret?: Redacted.Redacted<string>;
    readonly refreshToken: Redacted.Redacted<string>;
  }) => Effect.Effect<
    IssuedTokens,
    | AuthDependencyError
    | InvalidAuthToken
    | InvalidCredentials
    | AuthValidationError
    | AuthStoreError
  >;
  readonly revoke: (input: {
    readonly tenantId: TenantId;
    readonly clientId: string;
    readonly clientSecret?: Redacted.Redacted<string>;
    readonly token: Redacted.Redacted<string>;
  }) => Effect.Effect<void, AuthDependencyError | AuthStoreError>;
  readonly introspect: (input: {
    readonly tenantId: TenantId;
    readonly clientId: string;
    readonly clientSecret?: Redacted.Redacted<string>;
    readonly token: Redacted.Redacted<string>;
  }) => Effect.Effect<
    TokenIntrospection,
    AuthDependencyError | AuthValidationError | InvalidCredentials | AuthStoreError
  >;
  readonly jwks: () => { readonly keys: ReadonlyArray<Record<string, unknown>> };
  readonly verifyAccessToken: (
    tenantId: TenantId,
    token: Redacted.Redacted<string>,
  ) => Effect.Effect<AccessTokenClaims, InvalidAuthToken>;
  readonly startEndSession: (
    tenantId: TenantId,
    userId: UserId,
  ) => Effect.Effect<
    { readonly hint: Redacted.Redacted<string> },
    AuthDependencyError | AuthStoreError
  >;
  readonly completeEndSession: (
    tenantId: TenantId,
    hint: Redacted.Redacted<string>,
  ) => Effect.Effect<void, AuthDependencyError | InvalidAuthToken | AuthStoreError>;
}

const pkceS256 = (verifier: string): Effect.Effect<string, AuthDependencyError> =>
  Effect.gen(function* () {
    const digest = yield* Effect.tryPromise({
      try: () => crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
      catch: (cause) => new AuthDependencyError({ dependency: "sha256", operation: "pkce", cause }),
    });
    return encodeBase64Url(new Uint8Array(digest));
  });

const signJwt = (
  key: OAuthSigningKey,
  claims: Record<string, unknown>,
): Effect.Effect<string, AuthDependencyError> =>
  Effect.tryPromise({
    try: async () => {
      const header = {
        alg: "RS256",
        typ: "JWT",
        kid: key.kid,
      };
      const encode = (value: unknown): string =>
        encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
      const signingInput = `${encode(header)}.${encode(claims)}`;
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        key.privateKey,
        new TextEncoder().encode(signingInput),
      );
      return `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`;
    },
    catch: (cause) => new AuthDependencyError({ dependency: "rsa", operation: "sign-jwt", cause }),
  });

const decodeJwtSegment = (part: string | undefined): unknown =>
  JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(
        atob(
          (part ?? "")
            .replaceAll("-", "+")
            .replaceAll("_", "/")
            .padEnd(4 * Math.ceil((part ?? "").length / 4), "="),
        ),
        (character) => character.charCodeAt(0),
      ),
    ),
  ) as unknown;

/**
 * Decodes header and claims WITHOUT verifying the signature. Only for
 * record lookups by `jti` (revocation, introspection), where the record,
 * never the claims, is the source of truth. `verifyAccessToken` never
 * reads a claim before the signature has verified.
 */
const decodeJwtParts = (token: string): { readonly header: unknown; readonly claims: unknown } => {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("shape");
  return { header: decodeJwtSegment(parts[0]), claims: decodeJwtSegment(parts[1]) };
};

const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

/** The verifying key of a signing key, imported from its JWK once and cached. */
const verificationKeys = new WeakMap<OAuthSigningKey, Promise<CryptoKey>>();
const verificationKey = (key: OAuthSigningKey): Promise<CryptoKey> => {
  const cached = verificationKeys.get(key);
  if (cached !== undefined) return cached;
  const imported =
    key.publicKey !== undefined
      ? Promise.resolve(key.publicKey)
      : crypto.subtle.importKey(
          "jwk",
          { ...key.publicJwk, alg: "RS256", key_ops: ["verify"], ext: true },
          RS256,
          false,
          ["verify"],
        );
  verificationKeys.set(key, imported);
  return imported;
};

/**
 * Verifies a compact JWS under `key` (RS256 only): true when the signature
 * segment is a valid signature over `header.payload`, false for anything
 * else (a malformed segment, an empty signature, a foreign key).
 */
const verifyJwsSignature = (
  key: OAuthSigningKey,
  signingInput: string,
  signatureSegment: string,
): Promise<boolean> =>
  Promise.resolve()
    .then(async () => {
      const signature = decodeBase64Url(signatureSegment);
      if (signature.length === 0) return false;
      return crypto.subtle.verify(
        RS256.name,
        await verificationKey(key),
        signature as unknown as ArrayBuffer,
        new TextEncoder().encode(signingInput),
      );
    })
    .catch(() => false);

export const makeAuthorizationServer = (
  options: AuthorizationServerOptions,
): AuthorizationServer => {
  const now = options.primitives?.now ?? (() => new Date());
  const randomTokenImpl = options.primitives?.randomToken ?? randomToken;
  const hashToken = options.primitives?.hashToken ?? sha256;
  const accessTokenTtl = options.accessTokenTtlMillis ?? 10 * 60 * 1_000;
  const refreshTokenTtl = options.refreshTokenTtlMillis ?? 30 * 24 * 60 * 60 * 1_000;
  const codeTtl = options.codeTtlMillis ?? 60 * 1_000;
  const hintTtl = options.endSessionHintTtlMillis ?? 5 * 60 * 1_000;
  const audit = options.audit ?? noOpAuthAuditSink;

  const clientError = (reason: string): AuthValidationError =>
    new AuthValidationError({ field: "client", reason });

  const authenticateClient = (
    tenantId: TenantId,
    clientId: string,
    clientSecret: Redacted.Redacted<string> | undefined,
  ): Effect.Effect<
    OAuthClientRecord,
    AuthDependencyError | InvalidCredentials | AuthValidationError | AuthStoreError
  > =>
    Effect.gen(function* () {
      const client = yield* options.store.findClient(tenantId, clientId);
      if (client === undefined) return yield* new InvalidCredentials({ reason: "oauth-client" });
      if (client.clientType === "confidential") {
        if (clientSecret === undefined || client.secretHash === undefined) {
          return yield* new InvalidCredentials({ reason: "oauth-client-secret" });
        }
        const candidate = yield* hashToken(Redacted.value(clientSecret));
        if (candidate !== client.secretHash) {
          return yield* new InvalidCredentials({ reason: "oauth-client-secret" });
        }
      }
      return client;
    });

  const issueTokens = (
    tenantId: TenantId,
    issuer: string,
    client: OAuthClientRecord,
    userId: UserId | undefined,
    scope: ReadonlyArray<OAuthServerScope>,
    withRefresh: boolean,
    familyId: string,
  ): Effect.Effect<IssuedTokens, AuthDependencyError | AuthStoreError> =>
    Effect.gen(function* () {
      const issuedAt = now();
      const accessTokenId = randomTokenImpl(12);
      const claims = {
        iss: issuer,
        ...(userId === undefined ? {} : { sub: userId }),
        aud: client.clientId,
        scope: scope.join(" "),
        jti: accessTokenId,
        iat: Math.floor(issuedAt.getTime() / 1_000),
        exp: Math.floor((issuedAt.getTime() + accessTokenTtl) / 1_000),
        tid: tenantId,
      };
      const accessToken = yield* signJwt(options.signingKeys.current, claims);
      const accessExpiresAt = new Date(issuedAt.getTime() + accessTokenTtl);
      yield* options.store.putToken({
        tenantId,
        tokenId: accessTokenId,
        kind: "access",
        clientId: client.clientId,
        ...(userId === undefined ? {} : { userId }),
        scope: [...scope],
        familyId,
        expiresAt: accessExpiresAt,
        createdAt: issuedAt,
      });
      let refreshToken: string | undefined;
      if (withRefresh) {
        refreshToken = randomTokenImpl(32);
        const refreshHash = yield* hashToken(refreshToken);
        yield* options.store.putToken({
          tenantId,
          tokenId: randomTokenImpl(12),
          kind: "refresh",
          clientId: client.clientId,
          ...(userId === undefined ? {} : { userId }),
          scope: [...scope],
          tokenHash: refreshHash,
          familyId,
          expiresAt: new Date(issuedAt.getTime() + refreshTokenTtl),
          createdAt: issuedAt,
        });
      }
      return {
        accessToken,
        ...(refreshToken === undefined ? {} : { refreshToken }),
        tokenType: "Bearer" as const,
        expiresIn: Math.floor(accessTokenTtl / 1_000),
        scope: [...scope],
      };
    });

  return {
    registerClient: (tenantId, input, context) =>
      Effect.gen(function* () {
        const gate =
          context.kind === "anonymous"
            ? (options.registration?.anonymous ?? false)
            : (options.registration?.signedIn ?? false);
        if (!gate) {
          return yield* clientError("registration is closed on this server");
        }
        if (input.redirectUris.length === 0 || input.scopes.length === 0) {
          return yield* clientError("requires redirect URIs and scopes");
        }
        for (const uri of input.redirectUris) {
          let parsed: URL | undefined;
          try {
            parsed = new URL(uri);
          } catch {
            parsed = undefined;
          }
          if (parsed === undefined || !["https:", "http:"].includes(parsed.protocol)) {
            return yield* clientError("redirect URIs must be absolute http(s) URLs");
          }
        }
        const clientId = `as_${randomTokenImpl(12)}`;
        const clientSecret = input.clientType === "confidential" ? randomTokenImpl(32) : undefined;
        const record: OAuthClientRecord = {
          tenantId,
          clientId,
          ...(input.clientName === undefined ? {} : { clientName: input.clientName }),
          clientType: input.clientType,
          ...(clientSecret === undefined ? {} : { secretHash: yield* hashToken(clientSecret) }),
          redirectUris: [...input.redirectUris],
          scopes: [...input.scopes],
          createdAt: now(),
        };
        yield* options.store.putClient(record);
        return {
          ...(clientSecret === undefined ? {} : { clientSecret: Redacted.make(clientSecret) }),
          record,
        };
      }),
    authorize: (request, userId) =>
      Effect.gen(function* () {
        const _tenant = yield* options.resolveTenant(request.tenantId);
        const client = yield* options.store.findClient(request.tenantId, request.clientId);
        // Unknown client or bad redirect: fail closed — never redirect.
        if (client === undefined) return yield* clientError("is unknown");
        if (!client.redirectUris.includes(request.redirectUri)) {
          return yield* clientError("redirect_uri is not registered");
        }
        if (request.codeChallengeMethod !== "S256") {
          return yield* clientError("code_challenge_method must be S256");
        }
        if (request.codeChallenge.length < 43 || request.codeChallenge.length > 128) {
          return yield* clientError("code_challenge length must be 43..128");
        }
        const outsideVocabulary = request.scope.filter((scope) => !client.scopes.includes(scope));
        if (outsideVocabulary.length > 0) {
          return yield* clientError("requested scopes exceed the client's vocabulary");
        }
        // Stale consent: a grant missing any requested scope requires fresh consent.
        const consent = yield* options.store.findConsent(
          request.tenantId,
          request.clientId,
          userId,
        );
        const scopesCovered =
          consent !== undefined && request.scope.every((scope) => consent.scope.includes(scope));
        if (!scopesCovered) {
          return {
            consentRequired: true as const,
            ...(request.state === undefined ? {} : { state: request.state }),
          };
        }
        const code = randomTokenImpl(32);
        yield* options.store.putAuthorizationCode({
          tenantId: request.tenantId,
          codeHash: yield* hashToken(code),
          clientId: client.clientId,
          userId,
          redirectUri: request.redirectUri,
          scope: [...request.scope],
          codeChallenge: request.codeChallenge,
          expiresAt: new Date(now().getTime() + codeTtl),
        });
        const redirect = new URL(request.redirectUri);
        redirect.searchParams.set("code", code);
        if (request.state !== undefined) redirect.searchParams.set("state", request.state);
        return { redirectUrl: redirect.toString() };
      }),
    grantConsent: (input) =>
      Effect.gen(function* () {
        const client = yield* options.store.findClient(input.tenantId, input.clientId);
        if (client === undefined) return yield* clientError("is unknown");
        const outside = input.scope.filter((scope) => !client.scopes.includes(scope));
        if (outside.length > 0) {
          return yield* clientError("consent scopes exceed the client's vocabulary");
        }
        yield* options.store.putConsent({
          tenantId: input.tenantId,
          clientId: input.clientId,
          userId: input.userId,
          scope: [...input.scope],
          grantedAt: now(),
        });
      }),
    exchangeCode: (input) =>
      Effect.gen(function* () {
        const tenant = yield* options.resolveTenant(input.tenantId);
        const client = yield* authenticateClient(
          input.tenantId,
          input.clientId,
          input.clientSecret,
        );
        const codeHash = yield* hashToken(Redacted.value(input.code));
        const record = yield* options.store.consumeAuthorizationCode(
          input.tenantId,
          codeHash,
          now(),
        );
        // Replayed or expired codes are indistinguishable: single-use, 60s TTL.
        if (
          record === undefined ||
          record.clientId !== client.clientId ||
          record.redirectUri !== input.redirectUri
        ) {
          return yield* new InvalidAuthToken({ purpose: "oauth-code" });
        }
        const challenge = yield* pkceS256(input.codeVerifier);
        if (challenge !== record.codeChallenge) {
          return yield* new InvalidCredentials({ reason: "pkce" });
        }
        // Every grant starts a token family of its own.
        return yield* issueTokens(
          input.tenantId,
          tenant.baseUrl.toString(),
          client,
          record.userId,
          record.scope,
          true,
          randomTokenImpl(12),
        );
      }),
    refresh: (input) =>
      Effect.gen(function* () {
        const tenant = yield* options.resolveTenant(input.tenantId);
        const client = yield* authenticateClient(
          input.tenantId,
          input.clientId,
          input.clientSecret,
        );
        const tokenHash = yield* hashToken(Redacted.value(input.refreshToken));
        const record = yield* options.store.findTokenByHash(input.tenantId, tokenHash);
        if (
          record === undefined ||
          record.kind !== "refresh" ||
          record.clientId !== client.clientId ||
          record.expiresAt.getTime() <= now().getTime()
        ) {
          return yield* new InvalidAuthToken({ purpose: "oauth-refresh-token" });
        }
        const familyId = record.familyId ?? record.tokenId;
        if (record.revokedAt !== undefined) {
          // Reuse of a rotated-away refresh token is the one signal the
          // protocol gives that it leaked: whoever holds the descendants,
          // thief or victim, loses them all, and the event is audited.
          yield* options.store.revokeFamily(input.tenantId, familyId, now());
          yield* audit.record({
            tenantId: input.tenantId,
            action: "oauth-refresh-reuse",
            outcome: "succeeded",
            ...(record.userId === undefined ? {} : { userId: record.userId }),
          });
          return yield* new InvalidAuthToken({ purpose: "oauth-refresh-token" });
        }
        // Rotation: the old refresh token dies, a fresh pair joins its family.
        yield* options.store.revokeToken(input.tenantId, record.tokenId, now());
        return yield* issueTokens(
          input.tenantId,
          tenant.baseUrl.toString(),
          client,
          record.userId,
          record.scope,
          true,
          familyId,
        );
      }),
    revoke: (input) =>
      Effect.gen(function* () {
        yield* authenticateClient(input.tenantId, input.clientId, input.clientSecret).pipe(
          Effect.catchAll(() => Effect.void),
        );
        // RFC 7009: unknown or invalid tokens still answer success.
        const tokenHash = yield* hashToken(Redacted.value(input.token));
        const byHash = yield* options.store.findTokenByHash(input.tenantId, tokenHash);
        if (byHash !== undefined) {
          yield* options.store.revokeToken(input.tenantId, byHash.tokenId, now());
          return;
        }
        // Self-contained JWT access tokens revoke by id.
        let decoded: ReturnType<typeof decodeJwtParts> | undefined;
        try {
          decoded = decodeJwtParts(Redacted.value(input.token));
        } catch {
          decoded = undefined;
        }
        if (
          decoded !== undefined &&
          typeof decoded.claims === "object" &&
          decoded.claims !== null &&
          "jti" in decoded.claims &&
          typeof decoded.claims.jti === "string"
        ) {
          yield* options.store.revokeToken(input.tenantId, decoded.claims.jti, now());
        }
      }),
    introspect: (input) =>
      Effect.gen(function* () {
        const client = yield* authenticateClient(
          input.tenantId,
          input.clientId,
          input.clientSecret,
        );
        void client;
        const tokenHash = yield* hashToken(Redacted.value(input.token));
        const byHash = yield* options.store.findTokenByHash(input.tenantId, tokenHash);
        if (byHash !== undefined) {
          const active =
            byHash.revokedAt === undefined && byHash.expiresAt.getTime() > now().getTime();
          return {
            active,
            scope: byHash.scope.join(" "),
            clientId: byHash.clientId,
            ...(byHash.userId === undefined ? {} : { userId: byHash.userId }),
            expiresAt: byHash.expiresAt,
            ...(byHash.revokedAt === undefined ? {} : { revokedAt: byHash.revokedAt }),
          };
        }
        let decoded: ReturnType<typeof decodeJwtParts> | undefined;
        try {
          decoded = decodeJwtParts(Redacted.value(input.token));
        } catch {
          decoded = undefined;
        }
        if (
          decoded === undefined ||
          typeof decoded.claims !== "object" ||
          decoded.claims === null
        ) {
          return { active: false };
        }
        const claims = decoded.claims as Record<string, unknown>;
        const tokenId = claims.jti;
        if (typeof tokenId !== "string") return { active: false };
        const record = yield* options.store.findTokenById(input.tenantId, tokenId);
        if (record === undefined) return { active: false };
        const active =
          record.revokedAt === undefined && record.expiresAt.getTime() > now().getTime();
        return {
          active,
          ...(active
            ? {
                scope: record.scope.join(" "),
                clientId: record.clientId,
                ...(record.userId === undefined ? {} : { userId: record.userId }),
                expiresAt: record.expiresAt,
              }
            : {
                ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt }),
              }),
        };
      }),
    jwks: () => ({
      keys: [
        options.signingKeys.current.publicJwk,
        ...(options.signingKeys.previous === undefined
          ? []
          : [options.signingKeys.previous.publicJwk]),
      ],
    }),
    verifyAccessToken: (tenantId, token) =>
      Effect.gen(function* () {
        const invalid = () => new InvalidAuthToken({ purpose: "oauth-access-token" });
        const parts = Redacted.value(token).split(".");
        if (parts.length !== 3) return yield* invalid();
        const [headerSegment = "", claimsSegment = "", signatureSegment = ""] = parts;
        let header: unknown;
        try {
          header = decodeJwtSegment(headerSegment);
        } catch {
          return yield* invalid();
        }
        if (typeof header !== "object" || header === null) return yield* invalid();
        const { alg, kid } = header as Record<string, unknown>;
        // Only the algorithm this server signs with; `none` and every other
        // value are refused before any key is consulted.
        if (alg !== "RS256" || typeof kid !== "string") return yield* invalid();
        const key =
          kid === options.signingKeys.current.kid
            ? options.signingKeys.current
            : kid === options.signingKeys.previous?.kid
              ? options.signingKeys.previous
              : undefined;
        if (key === undefined) return yield* invalid();
        // Signature first: no claim is read before it verifies under the
        // key the header names.
        const signed = yield* Effect.promise(() =>
          verifyJwsSignature(key, `${headerSegment}.${claimsSegment}`, signatureSegment),
        );
        if (!signed) return yield* invalid();
        let decodedClaims: unknown;
        try {
          decodedClaims = decodeJwtSegment(claimsSegment);
        } catch {
          return yield* invalid();
        }
        if (typeof decodedClaims !== "object" || decodedClaims === null) {
          return yield* invalid();
        }
        // Rotation keeps outstanding tokens valid: records are consulted
        // (and revocation honored) regardless of which key signed the JWT.
        const claims = decodedClaims as Record<string, unknown>;
        const tokenId = claims.jti;
        if (typeof tokenId !== "string" || typeof claims.exp !== "number") {
          return yield* invalid();
        }
        if (claims.exp * 1_000 <= now().getTime()) return yield* invalid();
        if (claims.tid !== tenantId) return yield* invalid();
        const record = yield* Effect.orElseSucceed(
          options.store.findTokenById(tenantId, tokenId),
          () => undefined,
        );
        if (record === undefined || record.revokedAt !== undefined) return yield* invalid();
        return {
          iss: String(claims.iss ?? ""),
          sub: String(claims.sub ?? ""),
          aud: String(claims.aud ?? ""),
          scope: String(claims.scope ?? ""),
          jti: tokenId,
          exp: claims.exp,
          iat: Number(claims.iat ?? 0),
          tenantId,
        };
      }),
    startEndSession: (tenantId, userId) =>
      Effect.gen(function* () {
        void userId;
        const hint = randomTokenImpl(32);
        yield* options.store.putEndSessionHint({
          tenantId,
          hintHash: yield* hashToken(hint),
          expiresAt: new Date(now().getTime() + hintTtl),
        });
        return { hint: Redacted.make(hint) };
      }),
    completeEndSession: (tenantId, hint) =>
      Effect.gen(function* () {
        const hintHash = yield* hashToken(Redacted.value(hint));
        const record = yield* options.store.consumeEndSessionHint(tenantId, hintHash, now());
        // Single-use hints within a bounded grace; replays and stale hints fail.
        if (record === undefined) {
          return yield* new InvalidAuthToken({ purpose: "end-session-hint" });
        }
      }),
  };
};
