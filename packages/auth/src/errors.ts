import { Data } from "effect";

export type AuthFailureClass = "transient" | "permanent" | "conflict";

export class AuthValidationError extends Data.TaggedError("AuthValidationError")<{
  readonly field: string;
  readonly reason: string;
}> {
  readonly classification: AuthFailureClass = "permanent";
  override get message(): string {
    return `${this.field}: ${this.reason}`;
  }
}

export class InvalidCredentials extends Data.TaggedError("InvalidCredentials")<{
  readonly reason?: string;
}> {
  readonly classification: AuthFailureClass = "permanent";
  override get message(): string {
    return "The authentication credentials are invalid";
  }
}

export class EmailNotVerified extends Data.TaggedError("EmailNotVerified")<{
  readonly userId: string;
}> {
  readonly classification: AuthFailureClass = "permanent";
  override get message(): string {
    return "The email address must be verified before signing in";
  }
}

export class InvalidAuthToken extends Data.TaggedError("InvalidAuthToken")<{
  readonly purpose: string;
}> {
  readonly classification: AuthFailureClass = "permanent";
  override get message(): string {
    return "The authentication token is invalid or expired";
  }
}

export class IdentityConflict extends Data.TaggedError("IdentityConflict")<{
  readonly tenantId: string;
  readonly identity: string;
}> {
  readonly classification: AuthFailureClass = "conflict";
  override get message(): string {
    return "An authentication identity with that value already exists";
  }
}

export class AccountLinkDenied extends Data.TaggedError("AccountLinkDenied")<{
  readonly provider: string;
  readonly reason?: string;
}> {
  readonly classification: AuthFailureClass = "permanent";
  override get message(): string {
    return "The external identity cannot be linked automatically";
  }
}

export class AuthDependencyError extends Data.TaggedError("AuthDependencyError")<{
  readonly dependency: string;
  readonly operation: string;
  readonly cause?: unknown;
}> {
  readonly classification: AuthFailureClass = "transient";
  override get message(): string {
    return `${this.dependency} failed during ${this.operation}`;
  }
}

export class AuthStoreError extends Data.TaggedError("AuthStoreError")<{
  readonly operation: string;
  readonly cause?: unknown;
}> {
  readonly classification: AuthFailureClass = "transient";
  override get message(): string {
    return `Authentication storage failed during ${this.operation}`;
  }
}

export class UnsupportedPasskey extends Data.TaggedError("UnsupportedPasskey")<{
  readonly reason: string;
}> {
  readonly classification: AuthFailureClass = "permanent";
  override get message(): string {
    return `Unsupported passkey response: ${this.reason}`;
  }
}

export class RateLimitExceeded extends Data.TaggedError("RateLimitExceeded")<{
  readonly action: string;
  readonly retryAfterSeconds?: number;
}> {
  readonly classification: AuthFailureClass = "transient";
  override get message(): string {
    return "Too many authentication attempts";
  }
}

export type AuthError =
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
