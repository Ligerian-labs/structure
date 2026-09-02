import { Effect, Redacted } from "effect";
import type { DriverError, EmailDriver } from "../driver.js";
import { MailDeliveryFailed, MailRejected } from "../errors.js";
import type { EmailAddressInput, EmailMessage } from "../message.js";

export interface BrevoOptions {
  readonly apiKey: Redacted.Redacted<string>;
  /** API base URL; override to point at a proxy or a test stub. */
  readonly baseUrl?: string;
  /** Per-request timeout. Default 10s. */
  readonly timeoutMillis?: number;
  /** Injectable transport for tests. Defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

interface BrevoContact {
  readonly email: string;
  readonly name?: string;
}

const contact = (value: EmailAddressInput): BrevoContact =>
  value.name === undefined ? { email: value.email } : { email: value.email, name: value.name };

const contacts = (list: ReadonlyArray<EmailAddressInput>): ReadonlyArray<BrevoContact> =>
  list.map(contact);

const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 425, 429]);

const classify = (status: number, headers: Headers): DriverError => {
  const retryAfter = headers.get("retry-after");
  const retryAfterSeconds =
    retryAfter !== null && /^\d+$/u.test(retryAfter) ? Number(retryAfter) : undefined;
  return status >= 500 || RETRYABLE_STATUSES.has(status)
    ? new MailDeliveryFailed({
        driver: "brevo",
        reason: `brevo-${status}`,
        ...(retryAfterSeconds !== undefined && { retryAfterSeconds }),
      })
    : new MailRejected({ driver: "brevo", reason: `brevo-${status}` });
};

const request = async (
  options: BrevoOptions,
  message: EmailMessage,
  signal: AbortSignal,
): Promise<void> => {
  const baseUrl = options.baseUrl ?? "https://api.brevo.com";
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${baseUrl}/v3/smtp/email`, {
    method: "POST",
    headers: {
      "api-key": Redacted.value(options.apiKey),
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      sender: contact(message.from),
      to: [...contacts(message.to)],
      ...(message.cc === undefined ? {} : { cc: [...contacts(message.cc)] }),
      ...(message.bcc === undefined ? {} : { bcc: [...contacts(message.bcc)] }),
      ...(message.replyTo === undefined ? {} : { replyTo: contact(message.replyTo) }),
      subject: message.subject,
      ...(message.html === undefined ? {} : { htmlContent: message.html }),
      ...(message.text === undefined ? {} : { textContent: message.text }),
      ...(message.headers === undefined ? {} : { headers: message.headers }),
      ...(message.attachments === undefined
        ? {}
        : {
            attachment: message.attachments.map((attachment) => ({
              name: attachment.filename,
              content: attachment.contentBase64,
            })),
          }),
    }),
    signal,
  });
  if (response.ok) return;
  throw classify(response.status, response.headers);
};

/**
 * Brevo driver (https://brevo.com): one `POST /v3/smtp/email` per message,
 * authenticated with the `api-key` header. Brevo answers 201 (sent) or 202
 * (scheduled) on success. 4xx responses are permanent rejections; 429/408/425
 * and 5xx are transient. Attachments ride inline as base64 (`attachment[].content`).
 */
export const makeBrevoDriver = (options: BrevoOptions): EmailDriver => ({
  name: "brevo",
  send: (message) =>
    Effect.tryPromise({
      try: () => request(options, message, AbortSignal.timeout(options.timeoutMillis ?? 10_000)),
      catch: (cause): DriverError =>
        cause instanceof MailRejected || cause instanceof MailDeliveryFailed
          ? cause
          : new MailDeliveryFailed({ driver: "brevo", reason: "brevo-network" }),
    }),
});
