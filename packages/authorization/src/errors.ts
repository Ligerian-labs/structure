import type { FailureClass } from "@structure-ai/domain";
import { Data } from "effect";

/**
 * No principal is attached to the current fiber (or the attached one is
 * anonymous) and the action needs one. Maps to HTTP 401: authenticating may
 * help, retrying as-is cannot.
 */
export class Unauthenticated extends Data.TaggedError("Unauthenticated")<{
  readonly permission?: string;
  readonly reason?: string;
}> {
  readonly classification: FailureClass = "permanent";
  override get message(): string {
    const what = this.permission === undefined ? "" : ` for "${this.permission}"`;
    const why = this.reason === undefined ? "" : `: ${this.reason}`;
    return `authentication required${what}${why}`;
  }
}

/**
 * The principal is known but no role grants the permission (in the requested
 * scope, under the evaluated conditions). Maps to HTTP 403. Permanent:
 * retrying as the same principal cannot help.
 */
export class PermissionDenied extends Data.TaggedError("PermissionDenied")<{
  readonly permission: string;
  readonly principal: string;
  readonly scope?: string;
  readonly reason?: string;
}> {
  readonly classification: FailureClass = "permanent";
  override get message(): string {
    const where = this.scope === undefined ? "" : ` in scope "${this.scope}"`;
    const why = this.reason === undefined ? "" : `: ${this.reason}`;
    return `principal "${this.principal}" lacks "${this.permission}"${where}${why}`;
  }
}

/**
 * A policy definition is inconsistent: unknown permission or role referenced,
 * inheritance cycle, malformed resource/action name. Permanent: it is a
 * wiring bug, reported with every issue at once.
 */
export class InvalidPolicy extends Data.TaggedError("InvalidPolicy")<{
  readonly issues: ReadonlyArray<string>;
}> {
  readonly classification: FailureClass = "permanent";
  override get message(): string {
    return `policy is invalid:\n${this.issues.map((issue) => `  - ${issue}`).join("\n")}`;
  }
}

/** Every failure this package produces. */
export type AuthorizationError = Unauthenticated | PermissionDenied | InvalidPolicy;
