import { Effect, Redacted } from "effect";
import type { DriverError, EmailDriver } from "../driver.js";
import { MailDeliveryFailed, MailRejected } from "../errors.js";
import type { EmailAddressInput, EmailMessage } from "../message.js";

export interface ResendOptions {
  readonly apiKey: Redacted.Redacted<string>;
  /** API base URL; override to point at a proxy or a test stub. */
  readonly baseUrl?: string;
  /** Per-request timeout. Default 10s. */
  readonly timeoutMillis?: number;
  /** Injectable transport for tests. Defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

const address = (value: EmailAddressInput): string =>
  value.name === undefined ? value.email : `${value.name} <${value.email}>`;

const addresses = (list: ReadonlyArray<EmailAddressInput>): ReadonlyArray<string> =>
  list.map(address);

const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 425, 429]);

const classify = (status: number, headers: Headers): DriverError => {
  const retryAfter = headers.get("retry-after");
  const retryAfterSeconds =
    retryAfter !== null && /^\d+$/u.test(retryAfter) ? Number(retryAfter) : undefined;
  return status >= 500 || RETRYABLE_STATUSES.has(status)
    ? new MailDeliveryFailed({
        driver: "resend",
        reason: `resend-${status}`,
        ...(retryAfterSeconds !== undefined && { retryAfterSeconds }),
      })
    : new MailRejected({ driver: "resend", reason: `resend-${status}` });
};

const request = async (
  options: ResendOptions,
  message: EmailMessage,
  signal: AbortSignal,
): Promise<void> => {
  const baseUrl = options.baseUrl ?? "https://api.resend.com";
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${baseUrl}/emails`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${Redacted.value(options.apiKey)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: address(message.from),
      to: [...addresses(message.to)],
      ...(message.cc === undefined ? {} : { cc: [...addresses(message.cc)] }),
      ...(message.bcc === undefined ? {} : { bcc: [...addresses(message.bcc)] }),
      ...(message.replyTo === undefined ? {} : { reply_to: address(message.replyTo) }),
      subject: message.subject,
      ...(message.html === undefined ? {} : { html: message.html }),
      ...(message.text === undefined ? {} : { text: message.text }),
      ...(message.headers === undefined ? {} : { headers: message.headers }),
      ...(message.attachments === undefined
        ? {}
        : {
            attachments: message.attachments.map((attachment) => ({
              filename: attachment.filename,
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
 * Resend driver (https://resend.com): one `POST /emails` per message.
 * 4xx responses are permanent rejections; 429/408/425 and 5xx are transient.
 */
export const makeResendDriver = (options: ResendOptions): EmailDriver => ({
  name: "resend",
  send: (message) =>
    Effect.tryPromise({
      try: () => request(options, message, AbortSignal.timeout(options.timeoutMillis ?? 10_000)),
      catch: (cause): DriverError =>
        cause instanceof MailRejected || cause instanceof MailDeliveryFailed
          ? cause
          : new MailDeliveryFailed({ driver: "resend", reason: "resend-network" }),
    }),
});
