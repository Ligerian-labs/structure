import type { FailureClass } from "@structure/domain";
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
