import { Data } from "effect";

export type MailFailureClass = "transient" | "permanent";

/** The message shape never reached a driver: retrying the same input cannot help. */
export class MailValidationError extends Data.TaggedError("MailValidationError")<{
  readonly field: string;
  readonly reason: string;
}> {
  readonly classification: MailFailureClass = "permanent";
  override get message(): string {
    return `${this.field}: ${this.reason}`;
  }
}

/**
 * The driver permanently rejected the message (SMTP 5xx, provider 4xx).
 * Retrying with the same message will fail again.
 */
export class MailRejected extends Data.TaggedError("MailRejected")<{
  readonly driver: string;
  /** Machine-readable reason code (e.g. `smtp-550`, `resend-422`) — never message content. */
  readonly reason: string;
}> {
  readonly classification: MailFailureClass = "permanent";
  override get message(): string {
    return `${this.driver} rejected the message (${this.reason})`;
  }
}

/**
 * Delivery failed transiently (SMTP 4xx, timeouts, connection failures,
 * provider 5xx/429). The mailer retries these with bounded jittered backoff.
 */
export class MailDeliveryFailed extends Data.TaggedError("MailDeliveryFailed")<{
  readonly driver: string;
  readonly reason: string;
  readonly attempt?: number;
  readonly retryAfterSeconds?: number;
}> {
  readonly classification: MailFailureClass = "transient";
  override get message(): string {
    return `${this.driver} could not deliver the message (${this.reason})`;
  }
}

export type MailError = MailDeliveryFailed | MailRejected | MailValidationError;
