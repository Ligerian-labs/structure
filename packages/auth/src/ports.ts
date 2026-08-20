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
  | "passkey-authenticate";

export interface RateLimitRequest {
  readonly tenantId: TenantId;
  readonly action: AuthAction;
  /** A SHA-256 digest of the email, token, provider, or credential key. */
  readonly keyHash: string;
}

export interface RateLimiter {
  readonly check: (
    request: RateLimitRequest,
  ) => Effect.Effect<void, AuthDependencyError | RateLimitExceeded>;
}

export const allowAllRateLimiter: RateLimiter = { check: () => Effect.void };

export interface AuthAuditEvent {
  readonly tenantId: TenantId;
  readonly action: AuthAction | "session-sign-out" | "sessions-revoked";
  readonly outcome: "succeeded";
  readonly userId?: string;
  readonly provider?: OAuthProviderId;
}

export interface AuthAuditSink {
  /** Implementations must redact and absorb their own delivery failures. */
  readonly record: (event: AuthAuditEvent) => Effect.Effect<void>;
}

export const noOpAuthAuditSink: AuthAuditSink = { record: () => Effect.void };
