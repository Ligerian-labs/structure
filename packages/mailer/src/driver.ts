import type { Effect } from "effect";
import type { MailDeliveryFailed, MailRejected } from "./errors.js";
import type { EmailMessage } from "./message.js";

/** Driver-level failures: a permanent rejection or a transient delivery failure. */
export type DriverError = MailDeliveryFailed | MailRejected;

/**
 * One outbound email transport. Implementations:
 *
 * - validate nothing (the `Mailer` validates before calling `send`);
 * - classify every failure as permanent (`MailRejected`) or transient
 *   (`MailDeliveryFailed`) — the mailer only retries transient ones;
 * - never log message content; `reason` codes must not embed bodies or subjects.
 */
export interface EmailDriver {
  /** Stable, low-cardinality label used in metrics and logs (e.g. `smtp`). */
  readonly name: string;
  readonly send: (message: EmailMessage) => Effect.Effect<void, DriverError>;
}
