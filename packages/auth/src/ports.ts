import { Effect } from "effect";
import type { AuthDependencyError, RateLimitExceeded } from "./errors.js";
import type { OAuthProviderId, TenantId } from "./model.js";

export type AuthAction =
  | "password-register"
  | "email-verify"
  | "password-sign-in"
  | "password-reset-request"
  | "password-reset-complete"
  | "password-change"
  | "magic-link-request"
  | "magic-link-consume"
  | "oauth-start"
  | "oauth-complete"
  | "passkey-register"
  | "passkey-authenticate"
  | "apikey-verify"
  | "totp-enroll"
  | "totp-confirm"
  | "totp-verify"
  | "totp-unenroll";

export interface RateLimitRequest {
  readonly tenantId: TenantId;
  readonly action: AuthAction;
  /** A SHA-256 digest of the email, token, provider, or credential key. */
  readonly keyHash: string;
}

/**
 * Who is calling an anonymous entry point, as the application identifies
 * it: the client address behind its trusted proxy, or any per-request
 * subject it derives. Hashed before it reaches the limiter, like every
 * other key. Anonymous walls (a discoverable passkey challenge, an external
 * sign-in start, a password sign-in) key on it so one caller's budget is
 * never shared with everyone else's.
 */
export interface AuthCaller {
  readonly subject: string;
}

export interface RateLimiter {
  /** Charges one attempt against the bucket; refuses once it is exhausted. */
  readonly check: (
    request: RateLimitRequest,
  ) => Effect.Effect<void, AuthDependencyError | RateLimitExceeded>;
  /**
   * Refuses when the bucket is exhausted WITHOUT charging it. Optional:
   * a limiter that implements it lets the password sign-in wall peek
   * before verifying and charge (`check`) only a failed verification, so
   * naming a victim's email costs the attacker their own budget, not the
   * victim's sign-in. Without it the wall keeps charging on arrival.
   */
  readonly peek?: (
    request: RateLimitRequest,
  ) => Effect.Effect<void, AuthDependencyError | RateLimitExceeded>;
}

export const allowAllRateLimiter: RateLimiter = { check: () => Effect.void };

export interface AuthAuditEvent {
  readonly tenantId: TenantId;
  readonly action:
    | AuthAction
    | "session-sign-out"
    | "sessions-revoked"
    | "apikey-mint"
    | "apikey-revoke"
    | "totp-locked"
    | "oauth-unlink"
    | "oauth-refresh-reuse";
  readonly outcome: "succeeded";
  readonly userId?: string;
  readonly provider?: OAuthProviderId;
}

export interface AuthAuditSink {
  /** Implementations must redact and absorb their own delivery failures. */
  readonly record: (event: AuthAuditEvent) => Effect.Effect<void>;
}

export const noOpAuthAuditSink: AuthAuditSink = { record: () => Effect.void };
