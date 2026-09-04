import { Effect, Redacted } from "effect";
import { argon2id, encodeBase64Url, type PasswordHasher, randomToken, sha256 } from "./crypto.js";
import {
  AccountLinkDenied,
  AuthDependencyError,
  type AuthStoreError,
  AuthValidationError,
  EmailNotVerified,
  type IdentityConflict,
  InvalidAuthToken,
  InvalidCredentials,
  type RateLimitExceeded,
  type UnsupportedPasskey,
} from "./errors.js";
import type {
  AuthEmail,
  AuthSession,
  AuthUser,
  OAuthProfile,
  OneTimeTokenPurpose,
  TenantAuthConfig,
  TenantId,
} from "./model.js";
import {
  type AccountLinkPolicy,
  defaultOAuthProviderResolver,
  denyAccountLinking,
  exchangeOAuthCode,
  fetchOAuthHttpClient,
  type OAuthHttpClient,
  type OAuthProviderResolver,
  pkceChallenge,
  validateReturnTo,
} from "./oauth.js";
import {
  type AuthAction,
  type AuthAuditSink,
  noOpAuthAuditSink,
  type RateLimiter,
} from "./ports.js";
import type { AuthStore } from "./store.js";
import {
  type PasskeyAuthenticationOptions,
  type PasskeyAuthenticationResponse,
  type PasskeyRegistrationOptions,
  type PasskeyRegistrationResponse,
  passkeyChallengeFromClientData,
  verifyPasskeyAuthentication,
  verifyPasskeyRegistration,
} from "./webauthn.js";

const DEFAULT_SESSION_TTL = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_VERIFY_TTL = 24 * 60 * 60 * 1_000;
const DEFAULT_MAGIC_TTL = 15 * 60 * 1_000;
const DEFAULT_RESET_TTL = 60 * 60 * 1_000;

export interface AuthPrimitives {
  readonly now: () => Date;
  readonly randomToken: (byteLength?: number) => string;
  readonly hashToken: (token: string) => Effect.Effect<string, AuthDependencyError>;
}

export interface EmailSender {
  readonly send: (email: AuthEmail) => Effect.Effect<void, AuthDependencyError>;
}

export interface MakeAuthOptions {
  readonly store: AuthStore;
  readonly resolveTenant: (
    tenantId: TenantId,
  ) => Effect.Effect<TenantAuthConfig, AuthDependencyError | AuthValidationError>;
  readonly emailSender: EmailSender;
  readonly passwordHasher?: PasswordHasher;
  readonly primitives?: Partial<AuthPrimitives>;
  readonly oauthHttpClient?: OAuthHttpClient;
  readonly oauthProviderResolver?: OAuthProviderResolver;
  readonly accountLinkPolicy?: AccountLinkPolicy;
  /**
   * Gate for provisioning brand-new identities: consulted before an unknown
   * external identity creates an account. Absent (default), provisioning is
   * allowed — the social-provider behavior. Wire it to JIT settings for
   * generic OIDC (default off: only already-known identities sign in).
   */
  readonly identityProvisioning?: {
    readonly allow: (request: IdentityProvisionRequest) => Effect.Effect<boolean>;
  };
  readonly rateLimiter: RateLimiter;
  readonly audit?: AuthAuditSink;
  /**
   * Second-factor hook: when set and it reports an enrolled user, sessions
   * for that user are created `2fa-pending` (no `elevatedAt`) — wire it to
   * `TotpService.isEnrolled`. Absent (default), sessions need no elevation.
   */
  readonly secondFactor?: {
    readonly isEnrolled: (tenantId: TenantId, userId: string) => Effect.Effect<boolean>;
  };
}

export interface RegisterPasswordInput {
  readonly tenantId: TenantId;
  readonly email: string;
  readonly password: string;
  readonly displayName?: string;
}

export interface BeginOAuthOptions {
  readonly returnTo?: string;
  /** Absolute application path compiled from the handler's OAuth callback route. */
  readonly callbackPath?: string;
}

/** An unknown external identity asking to become an account. */
export interface IdentityProvisionRequest {
  readonly tenantId: TenantId;
  readonly provider: import("./model.js").OAuthProviderId;
  readonly subject: string;
  readonly email?: string;
}

export interface AuthService {
  readonly registerPassword: (
    input: RegisterPasswordInput,
  ) => Effect.Effect<AuthUser, AuthServiceError>;
  readonly requestEmailVerification: (
    tenantId: TenantId,
    email: string,
  ) => Effect.Effect<void, AuthServiceError>;
  readonly verifyEmail: (
    tenantId: TenantId,
    token: Redacted.Redacted<string>,
  ) => Effect.Effect<AuthUser, AuthServiceError>;
  readonly signInPassword: (
    tenantId: TenantId,
    email: string,
    password: string,
  ) => Effect.Effect<AuthSession, AuthServiceError>;
  readonly requestPasswordReset: (
    tenantId: TenantId,
    email: string,
  ) => Effect.Effect<void, AuthServiceError>;
  readonly resetPassword: (
    tenantId: TenantId,
    token: Redacted.Redacted<string>,
    newPassword: string,
  ) => Effect.Effect<AuthSession, AuthServiceError>;
  readonly changePassword: (
    tenantId: TenantId,
    sessionToken: Redacted.Redacted<string>,
    currentPassword: string,
    newPassword: string,
  ) => Effect.Effect<AuthSession, AuthServiceError>;
  readonly requestMagicLink: (
    tenantId: TenantId,
    email: string,
  ) => Effect.Effect<void, AuthServiceError>;
  readonly consumeMagicLink: (
    tenantId: TenantId,
    token: Redacted.Redacted<string>,
  ) => Effect.Effect<AuthSession, AuthServiceError>;
  readonly getSession: (
    tenantId: TenantId,
    token: Redacted.Redacted<string>,
  ) => Effect.Effect<AuthSession, AuthServiceError>;
  readonly signOut: (
    tenantId: TenantId,
    token: Redacted.Redacted<string>,
  ) => Effect.Effect<void, AuthServiceError>;
  readonly revokeAllSessions: (
    tenantId: TenantId,
    userId: string,
  ) => Effect.Effect<void, AuthServiceError>;
  readonly sessionCookie: (
    tenantId: TenantId,
    session: AuthSession | undefined,
  ) => Effect.Effect<string, AuthServiceError>;
  readonly sessionTokenFromCookie: (
    tenantId: TenantId,
    cookieHeader: string | null,
  ) => Effect.Effect<Redacted.Redacted<string> | undefined, AuthServiceError>;
  readonly beginOAuth: (
    tenantId: TenantId,
    provider: import("./model.js").OAuthProviderId,
    options?: string | BeginOAuthOptions,
  ) => Effect.Effect<{ readonly authorizationUrl: string }, AuthServiceError>;
  /** Returns the exact callback URI to register with an OAuth provider. */
  readonly authorizationServerRedirectUri: (
    tenantId: TenantId,
    provider: import("./model.js").OAuthProviderId,
    callbackPath?: string,
  ) => Effect.Effect<string, AuthServiceError>;
  readonly completeOAuth: (input: {
    readonly tenantId: TenantId;
    readonly provider: import("./model.js").OAuthProviderId;
    readonly state: Redacted.Redacted<string>;
    readonly code: Redacted.Redacted<string>;
    readonly currentSessionToken?: Redacted.Redacted<string>;
  }) => Effect.Effect<
    { readonly session: AuthSession; readonly returnTo?: string },
    AuthServiceError
  >;
  readonly beginPasskeyRegistration: (
    tenantId: TenantId,
    sessionToken: Redacted.Redacted<string>,
  ) => Effect.Effect<PasskeyRegistrationOptions, AuthServiceError>;
  readonly finishPasskeyRegistration: (
    tenantId: TenantId,
    sessionToken: Redacted.Redacted<string>,
    response: PasskeyRegistrationResponse,
  ) => Effect.Effect<void, AuthServiceError>;
  readonly beginPasskeyAuthentication: (
    tenantId: TenantId,
    email?: string,
  ) => Effect.Effect<PasskeyAuthenticationOptions, AuthServiceError>;
  readonly finishPasskeyAuthentication: (
    tenantId: TenantId,
    response: PasskeyAuthenticationResponse,
  ) => Effect.Effect<AuthSession, AuthServiceError>;
  /** Unlinks an external identity from the signed-in user (owner action). */
  readonly unlinkOAuthIdentity: (
    tenantId: TenantId,
    sessionToken: Redacted.Redacted<string>,
    provider: import("./model.js").OAuthProviderId,
  ) => Effect.Effect<void, AuthServiceError>;
}

export type AuthServiceError =
  | AccountLinkDenied
  | AuthDependencyError
  | AuthStoreError
  | AuthValidationError
  | EmailNotVerified
  | IdentityConflict
  | InvalidAuthToken
  | InvalidCredentials
  | RateLimitExceeded
  | UnsupportedPasskey;

const normalizeEmail = (value: string): Effect.Effect<string, AuthValidationError> => {
  const email = value.trim().toLowerCase();
  const at = email.indexOf("@");
  const hasAsciiControlOrSpace = [...email].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 32 || code === 127;
  });
  if (
    email.length > 320 ||
    at <= 0 ||
    at !== email.lastIndexOf("@") ||
    at > 64 ||
    email.length - at - 1 > 255 ||
    at === email.length - 1 ||
    hasAsciiControlOrSpace
  ) {
    return Effect.fail(new AuthValidationError({ field: "email", reason: "must be valid" }));
  }
  return Effect.succeed(email);
};

const validateOAuthProfile = (
  profile: OAuthProfile,
): Effect.Effect<OAuthProfile, AuthDependencyError> =>
  Effect.gen(function* () {
    if (
      profile.subject.length === 0 ||
      profile.subject.length > 1_024 ||
      profile.subject.trim() !== profile.subject ||
      profile.subject.includes("\u0000")
    ) {
      return yield* new AuthDependencyError({
        dependency: "oauth-provider",
        operation: "validate-profile-subject",
      });
    }
    const email =
      profile.email === undefined
        ? undefined
        : yield* normalizeEmail(profile.email).pipe(
            Effect.mapError(
              () =>
                new AuthDependencyError({
                  dependency: "oauth-provider",
                  operation: "validate-profile-email",
                }),
            ),
          );
    if (
      profile.displayName !== undefined &&
      (profile.displayName.length > 512 || profile.displayName.includes("\u0000"))
    ) {
      return yield* new AuthDependencyError({
        dependency: "oauth-provider",
        operation: "validate-profile-display-name",
      });
    }
    return {
      subject: profile.subject,
      ...(email === undefined ? {} : { email }),
      emailVerified: email !== undefined && profile.emailVerified,
      ...(profile.displayName === undefined ? {} : { displayName: profile.displayName }),
    };
  });

const validatePassword = (
  password: string,
  config: TenantAuthConfig,
): Effect.Effect<void, AuthValidationError> => {
  const min = config.password?.minLength ?? 12;
  const max = config.password?.maxLength ?? 256;
  if (password.length < min) {
    return Effect.fail(
      new AuthValidationError({
        field: "password",
        reason: `must contain at least ${min} characters`,
      }),
    );
  }
  if (password.length > max) {
    return Effect.fail(
      new AuthValidationError({
        field: "password",
        reason: `must contain at most ${max} characters`,
      }),
    );
  }
  return Effect.void;
};

const validateTenantConfig = (
  config: TenantAuthConfig,
): Effect.Effect<TenantAuthConfig, AuthValidationError> => {
  const localhost =
    config.baseUrl.hostname === "localhost" || config.baseUrl.hostname === "127.0.0.1";
  if (config.baseUrl.protocol !== "https:" && !(localhost && config.baseUrl.protocol === "http:")) {
    return Effect.fail(
      new AuthValidationError({
        field: "baseUrl",
        reason: "must use HTTPS except on localhost",
      }),
    );
  }
  if (config.baseUrl.username.length > 0 || config.baseUrl.password.length > 0) {
    return Effect.fail(
      new AuthValidationError({ field: "baseUrl", reason: "must not contain credentials" }),
    );
  }
  const cookieName = config.session?.cookieName ?? "structure_session";
  const cookiePath = config.session?.cookiePath ?? "/";
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(cookieName)) {
    return Effect.fail(
      new AuthValidationError({
        field: "session.cookieName",
        reason: "is not a valid cookie name",
      }),
    );
  }
  if (!cookiePath.startsWith("/") || /[;\r\n]/u.test(cookiePath)) {
    return Effect.fail(
      new AuthValidationError({ field: "session.cookiePath", reason: "is not a safe path" }),
    );
  }
  if (
    config.session?.cookieDomain !== undefined &&
    /[;\s\r\n]/u.test(config.session.cookieDomain)
  ) {
    return Effect.fail(
      new AuthValidationError({ field: "session.cookieDomain", reason: "is not a safe domain" }),
    );
  }
  if (config.session?.cookieSameSite === "None" && config.baseUrl.protocol !== "https:") {
    return Effect.fail(
      new AuthValidationError({
        field: "session.cookieSameSite",
        reason: "None requires HTTPS",
      }),
    );
  }
  if (config.passkey !== undefined) {
    if (config.passkey.rpId.length === 0 || config.passkey.origins.length === 0) {
      return Effect.fail(
        new AuthValidationError({ field: "passkey", reason: "requires an RP ID and origins" }),
      );
    }
    for (const originValue of config.passkey.origins) {
      let origin: URL;
      try {
        origin = new URL(originValue);
      } catch {
        return Effect.fail(
          new AuthValidationError({ field: "passkey.origins", reason: "must contain valid URLs" }),
        );
      }
      const localOrigin = origin.hostname === "localhost" || origin.hostname === "127.0.0.1";
      if (
        origin.origin !== originValue ||
        (origin.protocol !== "https:" && !(localOrigin && origin.protocol === "http:")) ||
        (origin.hostname !== config.passkey.rpId &&
          !origin.hostname.endsWith(`.${config.passkey.rpId}`))
      ) {
        return Effect.fail(
          new AuthValidationError({
            field: "passkey.origins",
            reason: "must be exact HTTPS origins within the RP ID",
          }),
        );
      }
    }
  }
  return Effect.succeed(config);
};

const tokenValue = (token: Redacted.Redacted<string>): string => Redacted.value(token);

export const makeAuth = (options: MakeAuthOptions): AuthService => {
  const hasher = options.passwordHasher ?? argon2id();
  const oauthHttp = options.oauthHttpClient ?? fetchOAuthHttpClient();
  const oauthProviders = options.oauthProviderResolver ?? defaultOAuthProviderResolver;
  const accountLinking = options.accountLinkPolicy ?? denyAccountLinking;
  const provisioning = options.identityProvisioning;
  const rateLimiter = options.rateLimiter;
  const audit = options.audit ?? noOpAuthAuditSink;
  const primitives: AuthPrimitives = {
    now: options.primitives?.now ?? (() => new Date()),
    randomToken: options.primitives?.randomToken ?? randomToken,
    hashToken: options.primitives?.hashToken ?? sha256,
  };

  const configFor = (tenantId: TenantId) =>
    options.resolveTenant(tenantId).pipe(Effect.flatMap(validateTenantConfig));

  const limit = (tenantId: TenantId, action: AuthAction, key: string) =>
    primitives
      .hashToken(key)
      .pipe(Effect.flatMap((keyHash) => rateLimiter.check({ tenantId, action, keyHash })));

  const recordAudit = (
    tenantId: TenantId,
    action: Parameters<AuthAuditSink["record"]>[0]["action"],
    outcome: "succeeded",
    details: {
      readonly userId?: string;
      readonly provider?: import("./model.js").OAuthProviderId;
    } = {},
  ) => audit.record({ tenantId, action, outcome, ...details });

  const createSession = (
    tenantId: TenantId,
    user: AuthUser,
    config: TenantAuthConfig,
  ): Effect.Effect<AuthSession, AuthServiceError> =>
    Effect.gen(function* () {
      const raw = primitives.randomToken(32);
      const hash = yield* primitives.hashToken(raw);
      const now = primitives.now();
      const expiresAt = new Date(
        now.getTime() + (config.session?.ttlMillis ?? DEFAULT_SESSION_TTL),
      );
      const pendingSecondFactor =
        options.secondFactor !== undefined &&
        (yield* options.secondFactor.isEnrolled(tenantId, user.id));
      yield* options.store.createSession({
        id: primitives.randomToken(18),
        tenantId,
        userId: user.id,
        tokenHash: hash,
        createdAt: now,
        expiresAt,
        ...(pendingSecondFactor ? {} : { elevatedAt: now }),
      });
      return { token: Redacted.make(raw), user, expiresAt };
    });

  const issueEmailToken = (
    tenantId: TenantId,
    config: TenantAuthConfig,
    purpose: OneTimeTokenPurpose,
    email: string,
    userId?: string,
  ): Effect.Effect<void, AuthServiceError> =>
    Effect.gen(function* () {
      const raw = primitives.randomToken(32);
      const tokenHash = yield* primitives.hashToken(raw);
      const ttl =
        purpose === "email-verification"
          ? (config.tokens?.emailVerificationTtlMillis ?? DEFAULT_VERIFY_TTL)
          : purpose === "magic-link"
            ? (config.tokens?.magicLinkTtlMillis ?? DEFAULT_MAGIC_TTL)
            : (config.tokens?.passwordResetTtlMillis ?? DEFAULT_RESET_TTL);
      const expiresAt = new Date(primitives.now().getTime() + ttl);
      yield* options.store.putOneTimeToken({
        tenantId,
        purpose,
        tokenHash,
        email,
        ...(userId === undefined ? {} : { userId }),
        expiresAt,
      });
      const paths: Record<OneTimeTokenPurpose, string> = {
        "email-verification": config.links?.emailVerification ?? "/auth/verify-email",
        "magic-link": config.links?.magicLink ?? "/auth/magic-link",
        "password-reset": config.links?.passwordReset ?? "/auth/reset-password",
      };
      const url = new URL(paths[purpose], config.baseUrl);
      url.searchParams.set("token", raw);
      yield* options.emailSender.send({
        kind: purpose,
        tenantId,
        to: email,
        url: url.toString(),
        token: Redacted.make(raw),
        expiresAt,
      });
    });

  const consumeToken = (
    tenantId: TenantId,
    purpose: OneTimeTokenPurpose,
    token: Redacted.Redacted<string>,
  ) =>
    Effect.gen(function* () {
      const hash = yield* primitives.hashToken(tokenValue(token));
      const record = yield* options.store.consumeOneTimeToken(
        tenantId,
        purpose,
        hash,
        primitives.now(),
      );
      if (record === undefined) return yield* new InvalidAuthToken({ purpose });
      return record;
    });

  const getSession = (
    tenantId: TenantId,
    token: Redacted.Redacted<string>,
  ): Effect.Effect<AuthSession, AuthServiceError> =>
    Effect.gen(function* () {
      const hash = yield* primitives.hashToken(tokenValue(token));
      const record = yield* options.store.findSession(tenantId, hash, primitives.now());
      if (record === undefined) return yield* new InvalidCredentials({ reason: "session" });
      const user = yield* options.store.findUserById(tenantId, record.userId);
      if (user === undefined) return yield* new InvalidCredentials({ reason: "session-user" });
      return { token, user, expiresAt: record.expiresAt };
    });

  const authorizationServerRedirectUri = (
    config: TenantAuthConfig,
    provider: import("./model.js").OAuthProviderId,
    callbackPath?: string,
  ): Effect.Effect<string, AuthValidationError> =>
    Effect.try({
      try: () => {
        const path = callbackPath ?? `/auth/oauth/${encodeURIComponent(provider)}/callback`;
        if (!path.startsWith("/") || path.startsWith("//")) {
          throw new Error("callback path must be absolute");
        }
        const redirect = new URL(path, config.baseUrl);
        if (redirect.origin !== config.baseUrl.origin) {
          throw new Error("callback must use the tenant origin");
        }
        return redirect.toString();
      },
      catch: () =>
        new AuthValidationError({
          field: "oauth.callbackPath",
          reason: "must be an absolute path on the tenant base URL origin",
        }),
    });

  return {
    registerPassword: (input) =>
      Effect.gen(function* () {
        const config = yield* configFor(input.tenantId);
        const email = yield* normalizeEmail(input.email);
        yield* limit(input.tenantId, "password-register", email);
        yield* validatePassword(input.password, config);
        const passwordHash = yield* hasher.hash(input.password);
        const now = primitives.now();
        const user: AuthUser = {
          id: primitives.randomToken(18),
          tenantId: input.tenantId,
          email,
          emailVerified: false,
          ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
          createdAt: now,
          updatedAt: now,
        };
        yield* options.store.createPasswordUser(user, {
          tenantId: input.tenantId,
          userId: user.id,
          email,
          passwordHash,
          updatedAt: now,
        });
        yield* issueEmailToken(input.tenantId, config, "email-verification", email, user.id);
        yield* recordAudit(input.tenantId, "password-register", "succeeded", { userId: user.id });
        return user;
      }),
    requestEmailVerification: (tenantId, inputEmail) =>
      Effect.gen(function* () {
        const config = yield* configFor(tenantId);
        const email = yield* normalizeEmail(inputEmail);
        yield* limit(tenantId, "email-verify", email);
        const user = yield* options.store.findUserByEmail(tenantId, email);
        if (user !== undefined && !user.emailVerified) {
          yield* issueEmailToken(tenantId, config, "email-verification", email, user.id);
        }
      }),
    verifyEmail: (tenantId, token) =>
      Effect.gen(function* () {
        yield* configFor(tenantId);
        yield* limit(tenantId, "email-verify", tokenValue(token));
        const record = yield* consumeToken(tenantId, "email-verification", token);
        if (record.userId === undefined) {
          return yield* new InvalidAuthToken({ purpose: "email-verification" });
        }
        const user = yield* options.store.setEmailVerified(
          tenantId,
          record.userId,
          primitives.now(),
        );
        if (user === undefined) {
          return yield* new InvalidAuthToken({ purpose: "email-verification" });
        }
        yield* recordAudit(tenantId, "email-verify", "succeeded", { userId: user.id });
        return user;
      }),
    signInPassword: (tenantId, inputEmail, password) =>
      Effect.gen(function* () {
        const config = yield* configFor(tenantId);
        const email = yield* normalizeEmail(inputEmail);
        yield* limit(tenantId, "password-sign-in", email);
        if (password.length === 0 || password.length > (config.password?.maxLength ?? 256)) {
          return yield* new InvalidCredentials({ reason: "password" });
        }
        const credential = yield* options.store.findPassword(tenantId, email);
        if (credential === undefined) {
          yield* hasher.hash("structure-auth-dummy-password");
          return yield* new InvalidCredentials({ reason: "password" });
        }
        const matches = yield* hasher.verify(password, credential.passwordHash);
        if (!matches) return yield* new InvalidCredentials({ reason: "password" });
        const user = yield* options.store.findUserById(tenantId, credential.userId);
        if (user === undefined) return yield* new InvalidCredentials({ reason: "password-user" });
        if (!user.emailVerified) return yield* new EmailNotVerified({ userId: user.id });
        const session = yield* createSession(tenantId, user, config);
        yield* recordAudit(tenantId, "password-sign-in", "succeeded", { userId: user.id });
        return session;
      }),
    requestPasswordReset: (tenantId, inputEmail) =>
      Effect.gen(function* () {
        const config = yield* configFor(tenantId);
        const email = yield* normalizeEmail(inputEmail);
        yield* limit(tenantId, "password-reset-request", email);
        const credential = yield* options.store.findPassword(tenantId, email);
        if (credential !== undefined) {
          yield* issueEmailToken(tenantId, config, "password-reset", email, credential.userId);
        }
      }),
    resetPassword: (tenantId, token, newPassword) =>
      Effect.gen(function* () {
        const config = yield* configFor(tenantId);
        yield* limit(tenantId, "password-reset-complete", tokenValue(token));
        yield* validatePassword(newPassword, config);
        const record = yield* consumeToken(tenantId, "password-reset", token);
        if (record.userId === undefined) {
          return yield* new InvalidAuthToken({ purpose: "password-reset" });
        }
        const passwordHash = yield* hasher.hash(newPassword);
        yield* options.store.replacePasswordAndRevokeSessions(
          tenantId,
          record.userId,
          passwordHash,
          primitives.now(),
        );
        const user = yield* options.store.findUserById(tenantId, record.userId);
        if (user === undefined) return yield* new InvalidAuthToken({ purpose: "password-reset" });
        const session = yield* createSession(tenantId, user, config);
        yield* recordAudit(tenantId, "password-reset-complete", "succeeded", { userId: user.id });
        return session;
      }),
    changePassword: (tenantId, sessionToken, currentPassword, newPassword) =>
      Effect.gen(function* () {
        const config = yield* configFor(tenantId);
        yield* limit(tenantId, "password-change", tokenValue(sessionToken));
        yield* validatePassword(newPassword, config);
        const session = yield* getSession(tenantId, sessionToken);
        if (session.user.email === undefined) {
          return yield* new InvalidCredentials({ reason: "password-identity" });
        }
        const credential = yield* options.store.findPassword(tenantId, session.user.email);
        if (credential === undefined) {
          return yield* new InvalidCredentials({ reason: "password-identity" });
        }
        const matches = yield* hasher.verify(currentPassword, credential.passwordHash);
        if (!matches) return yield* new InvalidCredentials({ reason: "password" });
        const passwordHash = yield* hasher.hash(newPassword);
        yield* options.store.replacePasswordAndRevokeSessions(
          tenantId,
          session.user.id,
          passwordHash,
          primitives.now(),
        );
        const changed = yield* createSession(tenantId, session.user, config);
        yield* recordAudit(tenantId, "password-change", "succeeded", { userId: session.user.id });
        return changed;
      }),
    requestMagicLink: (tenantId, inputEmail) =>
      Effect.gen(function* () {
        const config = yield* configFor(tenantId);
        const email = yield* normalizeEmail(inputEmail);
        yield* limit(tenantId, "magic-link-request", email);
        const user = yield* options.store.findUserByEmail(tenantId, email);
        yield* issueEmailToken(tenantId, config, "magic-link", email, user?.id);
      }),
    consumeMagicLink: (tenantId, token) =>
      Effect.gen(function* () {
        const config = yield* configFor(tenantId);
        yield* limit(tenantId, "magic-link-consume", tokenValue(token));
        const record = yield* consumeToken(tenantId, "magic-link", token);
        let user = yield* options.store.findUserByEmail(tenantId, record.email);
        if (user === undefined) {
          const now = primitives.now();
          const created: AuthUser = {
            id: primitives.randomToken(18),
            tenantId,
            email: record.email,
            emailVerified: true,
            createdAt: now,
            updatedAt: now,
          };
          const inserted = yield* options.store.createMagicLinkUser(created).pipe(
            Effect.as(true),
            Effect.catchTag("IdentityConflict", () => Effect.succeed(false)),
          );
          user = inserted ? created : yield* options.store.findUserByEmail(tenantId, record.email);
          if (user !== undefined && !user.emailVerified) {
            user = yield* options.store.setEmailVerified(tenantId, user.id, primitives.now());
          }
        } else if (!user.emailVerified) {
          user = yield* options.store.setEmailVerified(tenantId, user.id, primitives.now());
        }
        if (user === undefined) return yield* new InvalidAuthToken({ purpose: "magic-link" });
        const session = yield* createSession(tenantId, user, config);
        yield* recordAudit(tenantId, "magic-link-consume", "succeeded", { userId: user.id });
        return session;
      }),
    getSession,
    signOut: (tenantId, token) =>
      Effect.gen(function* () {
        yield* configFor(tenantId);
        const hash = yield* primitives.hashToken(tokenValue(token));
        yield* options.store.revokeSession(tenantId, hash);
        yield* recordAudit(tenantId, "session-sign-out", "succeeded");
      }),
    revokeAllSessions: (tenantId, userId) =>
      configFor(tenantId).pipe(
        Effect.flatMap(() => options.store.revokeUserSessions(tenantId, userId)),
        Effect.tap(() => recordAudit(tenantId, "sessions-revoked", "succeeded", { userId })),
      ),
    sessionCookie: (tenantId, session) =>
      Effect.gen(function* () {
        const config = yield* configFor(tenantId);
        const name = config.session?.cookieName ?? "structure_session";
        const path = config.session?.cookiePath ?? "/";
        const sameSite = config.session?.cookieSameSite ?? "Lax";
        const domain =
          config.session?.cookieDomain === undefined
            ? ""
            : `; Domain=${config.session.cookieDomain}`;
        const secure = config.baseUrl.protocol === "https:" ? "; Secure" : "";
        if (session === undefined) {
          return `${name}=; Path=${path}; HttpOnly; SameSite=${sameSite}${secure}; Max-Age=0${domain}`;
        }
        const maxAge = Math.max(
          0,
          Math.floor((session.expiresAt.getTime() - primitives.now().getTime()) / 1_000),
        );
        return `${name}=${tokenValue(session.token)}; Path=${path}; HttpOnly; SameSite=${sameSite}${secure}; Max-Age=${maxAge}${domain}`;
      }),
    sessionTokenFromCookie: (tenantId, cookieHeader) =>
      Effect.gen(function* () {
        const config = yield* configFor(tenantId);
        if (cookieHeader === null || cookieHeader.length > 16_384) return undefined;
        const name = config.session?.cookieName ?? "structure_session";
        for (const segment of cookieHeader.split(";")) {
          const separator = segment.indexOf("=");
          if (separator < 0) continue;
          const key = segment.slice(0, separator).trim();
          const value = segment.slice(separator + 1).trim();
          if (key === name && value.length > 0) return Redacted.make(value);
        }
        return undefined;
      }),
    authorizationServerRedirectUri: (tenantId, providerId, callbackPath) =>
      configFor(tenantId).pipe(
        Effect.flatMap((config) =>
          authorizationServerRedirectUri(config, providerId, callbackPath),
        ),
      ),
    beginOAuth: (tenantId, providerId, input) =>
      Effect.gen(function* () {
        const config = yield* configFor(tenantId);
        yield* limit(tenantId, "oauth-start", providerId);
        const provider = yield* oauthProviders.resolve(tenantId, providerId, config);
        if (provider === undefined) {
          return yield* new AuthValidationError({
            field: "provider",
            reason: "is not configured for this tenant",
          });
        }
        if (
          provider.id !== providerId ||
          provider.credentials.clientId.trim().length === 0 ||
          Redacted.value(provider.credentials.clientSecret).length === 0
        ) {
          return yield* new AuthValidationError({
            field: "oauth.credentials",
            reason: "must match the requested provider and contain a client ID and redacted secret",
          });
        }
        const beginOptions: BeginOAuthOptions =
          typeof input === "string" ? { returnTo: input } : (input ?? {});
        const safeReturnTo = yield* validateReturnTo(config, beginOptions.returnTo);
        const state = primitives.randomToken(32);
        const verifier = primitives.randomToken(48);
        const challenge = yield* pkceChallenge(verifier);
        const stateHash = yield* primitives.hashToken(state);
        const redirectUri = yield* authorizationServerRedirectUri(
          config,
          provider.id,
          beginOptions.callbackPath,
        );
        yield* options.store.putOAuthState({
          tenantId,
          provider: provider.id,
          stateHash,
          codeVerifier: Redacted.make(verifier),
          redirectUri,
          ...(safeReturnTo === undefined ? {} : { returnTo: safeReturnTo }),
          expiresAt: new Date(
            primitives.now().getTime() + (config.tokens?.oauthStateTtlMillis ?? 10 * 60 * 1_000),
          ),
        });
        const authorizationUrl = new URL(provider.authorizationEndpoint);
        authorizationUrl.searchParams.set("response_type", "code");
        authorizationUrl.searchParams.set("client_id", provider.credentials.clientId);
        authorizationUrl.searchParams.set("redirect_uri", redirectUri);
        authorizationUrl.searchParams.set("scope", provider.scopes.join(" "));
        authorizationUrl.searchParams.set("state", state);
        authorizationUrl.searchParams.set("code_challenge", challenge);
        authorizationUrl.searchParams.set("code_challenge_method", "S256");
        return { authorizationUrl: authorizationUrl.toString() };
      }),
    completeOAuth: (input) =>
      Effect.gen(function* () {
        const config = yield* configFor(input.tenantId);
        yield* limit(input.tenantId, "oauth-complete", tokenValue(input.state));
        const stateHash = yield* primitives.hashToken(tokenValue(input.state));
        const state = yield* options.store.consumeOAuthState(
          input.tenantId,
          stateHash,
          primitives.now(),
        );
        if (state === undefined || state.provider !== input.provider) {
          return yield* new InvalidAuthToken({ purpose: "oauth-state" });
        }
        const provider = yield* oauthProviders.resolve(input.tenantId, input.provider, config);
        if (provider === undefined) {
          return yield* new AuthValidationError({
            field: "provider",
            reason: "is not configured for this tenant",
          });
        }
        if (
          provider.id !== input.provider ||
          provider.credentials.clientId.trim().length === 0 ||
          Redacted.value(provider.credentials.clientSecret).length === 0
        ) {
          return yield* new AuthValidationError({
            field: "oauth.credentials",
            reason: "must match the requested provider and contain a client ID and redacted secret",
          });
        }
        const profile = yield* exchangeOAuthCode(provider, oauthHttp, {
          code: tokenValue(input.code),
          codeVerifier: state.codeVerifier,
          redirectUri: state.redirectUri,
        }).pipe(Effect.flatMap(validateOAuthProfile));
        const identity = yield* options.store.findOAuthIdentity(
          input.tenantId,
          input.provider,
          profile.subject,
        );
        const requestedBy =
          input.currentSessionToken === undefined
            ? undefined
            : yield* getSession(input.tenantId, input.currentSessionToken);
        if (identity !== undefined) {
          if (requestedBy !== undefined && requestedBy.user.id !== identity.userId) {
            return yield* new AccountLinkDenied({
              provider: input.provider,
              reason: "identity-belongs-to-another-user",
            });
          }
          const user = yield* options.store.findUserById(input.tenantId, identity.userId);
          if (user === undefined) return yield* new InvalidCredentials({ reason: "oauth-user" });
          const session = yield* createSession(input.tenantId, user, config);
          yield* recordAudit(input.tenantId, "oauth-complete", "succeeded", {
            userId: user.id,
            provider: input.provider,
          });
          return {
            session,
            ...(state.returnTo === undefined ? {} : { returnTo: state.returnTo }),
          };
        }

        const matchedUser =
          profile.email !== undefined && profile.emailVerified
            ? yield* options.store.findUserByEmail(
                input.tenantId,
                profile.email.trim().toLowerCase(),
              )
            : undefined;
        const target = requestedBy?.user ?? matchedUser;
        let user: AuthUser;
        if (target !== undefined) {
          const allowed = yield* accountLinking.authorize({
            tenantId: input.tenantId,
            provider: input.provider,
            providerSubject: profile.subject,
            profile,
            existingUserId: target.id,
            ...(requestedBy === undefined ? {} : { requestedByUserId: requestedBy.user.id }),
          });
          if (!allowed) {
            return yield* new AccountLinkDenied({ provider: input.provider });
          }
          user = target;
          yield* options.store.addOAuthIdentity({
            tenantId: input.tenantId,
            userId: user.id,
            provider: input.provider,
            subject: profile.subject,
            ...(profile.email === undefined ? {} : { email: profile.email }),
            createdAt: primitives.now(),
          });
          if (
            !user.emailVerified &&
            profile.emailVerified &&
            profile.email !== undefined &&
            user.email === profile.email
          ) {
            user =
              (yield* options.store.setEmailVerified(input.tenantId, user.id, primitives.now())) ??
              user;
          }
        } else {
          const provisioned =
            provisioning === undefined ||
            (yield* Effect.map(
              provisioning.allow({
                tenantId: input.tenantId,
                provider: input.provider,
                subject: profile.subject,
                ...(profile.email === undefined ? {} : { email: profile.email }),
              }),
              (allowed): boolean => allowed,
            ));
          if (!provisioned) {
            // JIT off: unknown identities are indistinguishable from wrong
            // credentials — no account enumeration.
            return yield* new InvalidCredentials({ reason: "oauth-identity" });
          }
          const now = primitives.now();
          user = {
            id: primitives.randomToken(18),
            tenantId: input.tenantId,
            ...(profile.email === undefined || !profile.emailVerified
              ? {}
              : { email: profile.email.trim().toLowerCase() }),
            emailVerified: profile.email !== undefined && profile.emailVerified,
            ...(profile.displayName === undefined ? {} : { displayName: profile.displayName }),
            createdAt: now,
            updatedAt: now,
          };
          yield* options.store.createOAuthUser(user, {
            tenantId: input.tenantId,
            userId: user.id,
            provider: input.provider,
            subject: profile.subject,
            ...(profile.email === undefined ? {} : { email: profile.email }),
            createdAt: now,
          });
        }
        const session = yield* createSession(input.tenantId, user, config);
        yield* recordAudit(input.tenantId, "oauth-complete", "succeeded", {
          userId: user.id,
          provider: input.provider,
        });
        return {
          session,
          ...(state.returnTo === undefined ? {} : { returnTo: state.returnTo }),
        };
      }),
    beginPasskeyRegistration: (tenantId, sessionToken) =>
      Effect.gen(function* () {
        const config = yield* configFor(tenantId);
        yield* limit(tenantId, "passkey-register", tokenValue(sessionToken));
        if (config.passkey === undefined) {
          return yield* new AuthValidationError({
            field: "passkey",
            reason: "is not configured for this tenant",
          });
        }
        const session = yield* getSession(tenantId, sessionToken);
        const challenge = primitives.randomToken(32);
        const challengeHash = yield* primitives.hashToken(challenge);
        yield* options.store.putPasskeyChallenge({
          tenantId,
          purpose: "registration",
          challengeHash,
          userId: session.user.id,
          expiresAt: new Date(
            primitives.now().getTime() +
              (config.tokens?.passkeyChallengeTtlMillis ?? 5 * 60 * 1_000),
          ),
        });
        const existing = yield* options.store.listPasskeys(tenantId, session.user.id);
        return {
          challenge,
          rp: { id: config.passkey.rpId, name: config.passkey.rpName },
          user: {
            id: encodeBase64Url(new TextEncoder().encode(session.user.id)),
            name: session.user.email ?? session.user.id,
            displayName: session.user.displayName ?? session.user.email ?? session.user.id,
          },
          pubKeyCredParams: [
            { type: "public-key", alg: -7 },
            { type: "public-key", alg: -257 },
            { type: "public-key", alg: -8 },
          ],
          timeout: config.tokens?.passkeyChallengeTtlMillis ?? 5 * 60 * 1_000,
          attestation: "none",
          authenticatorSelection: {
            residentKey: "preferred",
            userVerification:
              (config.passkey.requireUserVerification ?? true) ? "required" : "preferred",
          },
          excludeCredentials: existing.map((passkey) => ({
            type: "public-key",
            id: passkey.credentialId,
            transports: passkey.transports,
          })),
        };
      }),
    finishPasskeyRegistration: (tenantId, sessionToken, response) =>
      Effect.gen(function* () {
        const config = yield* configFor(tenantId);
        yield* limit(tenantId, "passkey-register", tokenValue(sessionToken));
        if (config.passkey === undefined) {
          return yield* new AuthValidationError({
            field: "passkey",
            reason: "is not configured for this tenant",
          });
        }
        const session = yield* getSession(tenantId, sessionToken);
        const clientChallenge = yield* passkeyChallengeFromClientData(
          response.response.clientDataJSON,
        );
        const challengeHash = yield* primitives.hashToken(clientChallenge);
        const challenge = yield* options.store.consumePasskeyChallenge(
          tenantId,
          "registration",
          challengeHash,
          primitives.now(),
        );
        if (challenge === undefined || challenge.userId !== session.user.id) {
          return yield* new InvalidAuthToken({ purpose: "passkey-registration-challenge" });
        }
        const verified = yield* verifyPasskeyRegistration(config.passkey, response);
        yield* options.store.addPasskey({
          tenantId,
          userId: session.user.id,
          credentialId: verified.credentialId,
          publicKey: verified.publicKey,
          algorithm: verified.algorithm,
          counter: verified.counter,
          transports: verified.transports,
          createdAt: primitives.now(),
        });
        yield* recordAudit(tenantId, "passkey-register", "succeeded", { userId: session.user.id });
      }),
    beginPasskeyAuthentication: (tenantId, inputEmail) =>
      Effect.gen(function* () {
        const config = yield* configFor(tenantId);
        yield* limit(tenantId, "passkey-authenticate", inputEmail ?? "discoverable");
        if (config.passkey === undefined) {
          return yield* new AuthValidationError({
            field: "passkey",
            reason: "is not configured for this tenant",
          });
        }
        const user =
          inputEmail === undefined
            ? undefined
            : yield* normalizeEmail(inputEmail).pipe(
                Effect.flatMap((email) => options.store.findUserByEmail(tenantId, email)),
              );
        const passkeys =
          user === undefined ? [] : yield* options.store.listPasskeys(tenantId, user.id);
        const challenge = primitives.randomToken(32);
        const challengeHash = yield* primitives.hashToken(challenge);
        yield* options.store.putPasskeyChallenge({
          tenantId,
          purpose: "authentication",
          challengeHash,
          ...(user === undefined ? {} : { userId: user.id }),
          expiresAt: new Date(
            primitives.now().getTime() +
              (config.tokens?.passkeyChallengeTtlMillis ?? 5 * 60 * 1_000),
          ),
        });
        return {
          challenge,
          rpId: config.passkey.rpId,
          timeout: config.tokens?.passkeyChallengeTtlMillis ?? 5 * 60 * 1_000,
          userVerification:
            (config.passkey.requireUserVerification ?? true) ? "required" : "preferred",
          ...(inputEmail === undefined
            ? {}
            : {
                allowCredentials: passkeys.map((passkey) => ({
                  type: "public-key" as const,
                  id: passkey.credentialId,
                  transports: passkey.transports,
                })),
              }),
        };
      }),
    unlinkOAuthIdentity: (tenantId, sessionToken, provider) =>
      Effect.gen(function* () {
        const config = yield* configFor(tenantId);
        void config;
        yield* limit(tenantId, "oauth-complete", tokenValue(sessionToken));
        const session = yield* getSession(tenantId, sessionToken);
        yield* options.store.removeOAuthIdentity(tenantId, session.user.id, provider);
        yield* recordAudit(tenantId, "oauth-unlink", "succeeded", {
          userId: session.user.id,
          provider,
        });
      }),
    finishPasskeyAuthentication: (tenantId, response) =>
      Effect.gen(function* () {
        const config = yield* configFor(tenantId);
        yield* limit(tenantId, "passkey-authenticate", response.credentialId);
        if (config.passkey === undefined) {
          return yield* new AuthValidationError({
            field: "passkey",
            reason: "is not configured for this tenant",
          });
        }
        const clientChallenge = yield* passkeyChallengeFromClientData(
          response.response.clientDataJSON,
        );
        const challengeHash = yield* primitives.hashToken(clientChallenge);
        const challenge = yield* options.store.consumePasskeyChallenge(
          tenantId,
          "authentication",
          challengeHash,
          primitives.now(),
        );
        if (challenge === undefined) {
          return yield* new InvalidAuthToken({ purpose: "passkey-authentication-challenge" });
        }
        const passkey = yield* options.store.findPasskey(tenantId, response.credentialId);
        if (
          passkey === undefined ||
          (challenge.userId !== undefined && challenge.userId !== passkey.userId)
        ) {
          return yield* new InvalidCredentials({ reason: "passkey" });
        }
        const verified = yield* verifyPasskeyAuthentication(config.passkey, passkey, response);
        yield* options.store.updatePasskeyCounter(
          tenantId,
          passkey.credentialId,
          passkey.counter,
          verified.counter,
        );
        const user = yield* options.store.findUserById(tenantId, passkey.userId);
        if (user === undefined) return yield* new InvalidCredentials({ reason: "passkey-user" });
        const session = yield* createSession(tenantId, user, config);
        yield* recordAudit(tenantId, "passkey-authenticate", "succeeded", { userId: user.id });
        return session;
      }),
  };
};
