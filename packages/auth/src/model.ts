import type { Redacted } from "effect";

export type TenantId = string;
export type UserId = string;
export type OAuthProviderId = "google" | "github" | "x" | "linkedin" | (string & {});
export type OneTimeTokenPurpose = "email-verification" | "magic-link" | "password-reset";
export type PasskeyChallengePurpose = "registration" | "authentication";

export interface AuthUser {
  readonly id: UserId;
  readonly tenantId: TenantId;
  readonly email?: string;
  readonly emailVerified: boolean;
  readonly displayName?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface PasswordCredential {
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly email: string;
  readonly passwordHash: string;
  readonly updatedAt: Date;
}

export interface OAuthIdentity {
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly provider: OAuthProviderId;
  readonly subject: string;
  readonly email?: string;
  readonly createdAt: Date;
}

export interface SessionRecord {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly tokenHash: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  /**
   * Set when the session satisfied (or never needed) a second factor;
   * absent while a confirmed TOTP enrollment keeps it `2fa-pending`.
   */
  readonly elevatedAt?: Date;
}

/** A TOTP enrollment: pending until confirmed with a first valid code. */
export interface TotpRecord {
  readonly tenantId: TenantId;
  readonly userId: UserId;
  /** The secret as the service stores it: sealed (`v1:…`) by `makeTotp`, never the plaintext. */
  readonly secretBase32: string;
  readonly confirmed: boolean;
  /** Salted keyed hashes of the single-use recovery codes (never the codes). */
  readonly recoveryCodeHashes: ReadonlyArray<string>;
  readonly failedAttempts: number;
  readonly lockedUntil?: Date;
  /**
   * The last time step whose code was accepted (verify, confirm, unenroll).
   * A code from that step or an earlier one is a replay, however valid.
   */
  readonly lastUsedStep?: number;
  readonly enrolledAt: Date;
}

export interface AuthSession {
  readonly token: Redacted.Redacted<string>;
  readonly user: AuthUser;
  readonly expiresAt: Date;
}

export interface OneTimeTokenRecord {
  readonly tenantId: TenantId;
  readonly purpose: OneTimeTokenPurpose;
  readonly tokenHash: string;
  readonly email: string;
  readonly userId?: UserId;
  readonly expiresAt: Date;
}

export interface OAuthStateRecord {
  readonly tenantId: TenantId;
  readonly provider: OAuthProviderId;
  readonly stateHash: string;
  readonly codeVerifier: Redacted.Redacted<string>;
  readonly redirectUri: string;
  readonly returnTo?: string;
  readonly expiresAt: Date;
}

export interface PasskeyChallengeRecord {
  readonly tenantId: TenantId;
  readonly purpose: PasskeyChallengePurpose;
  readonly challengeHash: string;
  readonly userId?: UserId;
  readonly expiresAt: Date;
}

export type PasskeyAlgorithm = "ES256" | "RS256" | "Ed25519";

export interface PasskeyRecord {
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly credentialId: string;
  readonly publicKey: string;
  readonly algorithm: PasskeyAlgorithm;
  readonly counter: number;
  readonly transports: ReadonlyArray<string>;
  readonly createdAt: Date;
}

export interface OAuthCredentials {
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted<string>;
}

export interface PasskeyTenantConfig {
  readonly rpId: string;
  readonly rpName: string;
  readonly origins: ReadonlyArray<string>;
  readonly requireUserVerification?: boolean;
}

export interface TenantAuthConfig {
  readonly baseUrl: URL;
  readonly password?: {
    readonly minLength?: number;
    readonly maxLength?: number;
  };
  readonly session?: {
    readonly ttlMillis?: number;
    readonly cookieName?: string;
    readonly cookieDomain?: string;
    readonly cookiePath?: string;
    readonly cookieSameSite?: "Lax" | "Strict" | "None";
  };
  readonly tokens?: {
    readonly emailVerificationTtlMillis?: number;
    readonly magicLinkTtlMillis?: number;
    readonly passwordResetTtlMillis?: number;
    readonly oauthStateTtlMillis?: number;
    readonly passkeyChallengeTtlMillis?: number;
  };
  readonly passkey?: PasskeyTenantConfig;
  readonly oauth?: Partial<Record<"google" | "github" | "x" | "linkedin", OAuthCredentials>>;
}

export interface AuthEmail {
  readonly kind: OneTimeTokenPurpose;
  readonly tenantId: TenantId;
  readonly to: string;
  readonly url: string;
  readonly token: Redacted.Redacted<string>;
  readonly expiresAt: Date;
}

export interface OAuthProfile {
  readonly subject: string;
  readonly email?: string;
  readonly emailVerified: boolean;
  readonly displayName?: string;
}
