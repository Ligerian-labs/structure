import type { FailureClass } from "@structure-ai/domain";
import { Data } from "effect";

/**
 * No handler was registered for the dispatched message tag (or the tag was
 * registered for the other message kind). Permanent: the wiring is wrong,
 * retrying the same dispatch cannot succeed.
 */
export class HandlerNotFound extends Data.TaggedError("HandlerNotFound")<{
  readonly tag: string;
  readonly kind: "command" | "query";
}> {
  readonly classification: FailureClass = "permanent";
  override get message(): string {
    return `no handler registered for ${this.kind} "${this.tag}"`;
  }
}

/**
 * The authorization hook rejected the action. Authorization is decided per
 * message (the action), not per endpoint, so the tag and acting principal
 * are part of the error. Permanent: retrying as the same actor cannot help.
 */
export class Unauthorized extends Data.TaggedError("Unauthorized")<{
  readonly tag: string;
  readonly actor?: string;
  readonly reason?: string;
}> {
  readonly classification: FailureClass = "permanent";
  override get message(): string {
    const who = this.actor === undefined ? "anonymous" : `actor "${this.actor}"`;
    const why = this.reason === undefined ? "" : `: ${this.reason}`;
    return `${who} is not allowed to dispatch "${this.tag}"${why}`;
  }
}

/**
 * The handler did not finish within the dispatch deadline. Transient: the
 * outcome of the interrupted handler is unknown and a retry may succeed —
 * pair retries with an idempotency key to avoid double effects.
 */
export class DispatchTimeout extends Data.TaggedError("DispatchTimeout")<{
  readonly tag: string;
  readonly timeoutMillis: number;
}> {
  readonly classification: FailureClass = "transient";
  override get message(): string {
    return `dispatch of "${this.tag}" timed out after ${this.timeoutMillis}ms`;
  }
}

/**
 * The idempotency key was already used by the same actor for this command
 * with a different payload. Conflict: the caller reused a key for another
 * request; it must pick a new key (or send the original payload).
 */
export class IdempotencyMismatch extends Data.TaggedError("IdempotencyMismatch")<{
  readonly tag: string;
  readonly key: string;
}> {
  readonly classification: FailureClass = "conflict";
  override get message(): string {
    return `idempotency key "${this.key}" was already used for "${this.tag}" with a different payload`;
  }
}

/**
 * Another dispatch with the same idempotency key is still running for the
 * same actor and command. Transient: once it completes, a retry replays its
 * result (or, if it failed, runs the handler).
 */
export class IdempotencyInFlight extends Data.TaggedError("IdempotencyInFlight")<{
  readonly tag: string;
  readonly key: string;
}> {
  readonly classification: FailureClass = "transient";
  override get message(): string {
    return `a dispatch of "${this.tag}" with idempotency key "${this.key}" is still in flight`;
  }
}
