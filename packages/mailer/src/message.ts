import { Schema } from "effect";

/**
 * Rejects CR, LF, NUL and every other C0/C1 control character without a
 * regex (linter-forbidden escapes): the guard behind header-injection
 * safety for names, subjects, and custom header values.
 */
export const freeOfControlCharacters = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 10 || code === 13 || (code >= 0 && code <= 31) || code === 127) {
      return false;
    }
  }
  return true;
};

/**
 * A validated email address. The pattern is deliberately conservative:
 * no whitespace, control characters, or address-list syntax — anything an
 * SMTP header would have to quote or that could smuggle header injection.
 */
export const EmailAddress = Schema.Struct({
  email: Schema.String.pipe(
    Schema.pattern(/^[^\s@;,"<>\\]+@[^\s@;,"<>\\]+\.[^\s@;,"<>\\]+$/u),
    Schema.maxLength(320),
  ),
  name: Schema.optional(
    Schema.String.pipe(
      Schema.filter(freeOfControlCharacters, {
        message: () => "must not contain control characters",
      }),
      Schema.maxLength(255),
    ),
  ),
}).annotations({ identifier: "EmailAddress" });

export type EmailAddressInput = Schema.Schema.Type<typeof EmailAddress>;

export const defaultFromAddress: EmailAddressInput = { email: "no-reply@localhost.invalid" };

/** A validated MIME attachment: filename, content type, base64 payload. */
export const EmailAttachment = Schema.Struct({
  filename: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(255),
    Schema.filter(freeOfControlCharacters, {
      message: () => "must not contain control characters",
    }),
    Schema.filter((value) => !value.includes("/"), { message: () => "must be a bare filename" }),
  ),
  contentType: Schema.String.pipe(
    Schema.pattern(/^[!#$%&'*+.^_`|~0-9A-Za-z/-]+$/u),
    Schema.maxLength(255),
  ),
  /** Base64-encoded bytes (standard alphabet, padded). ~10 MiB decoded at most. */
  contentBase64: Schema.String.pipe(
    Schema.pattern(/^[A-Za-z0-9+/]*={0,2}$/u),
    Schema.maxLength(14_000_000),
  ),
}).annotations({ identifier: "EmailAttachment" });

const headerName = Schema.String.pipe(
  Schema.pattern(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u),
  Schema.maxLength(128),
);
const headerValue = Schema.String.pipe(
  Schema.filter(freeOfControlCharacters, { message: () => "must not contain control characters" }),
  Schema.maxLength(998),
);

/** Custom transport headers. Names and values are validated against CRLF injection. */
export const EmailHeaders = Schema.Record({ key: headerName, value: headerValue });

/** A validated, ready-to-send email. */
export const EmailMessage = Schema.Struct({
  from: EmailAddress,
  to: Schema.Array(EmailAddress).pipe(Schema.minItems(1), Schema.maxItems(50)),
  cc: Schema.optional(Schema.Array(EmailAddress).pipe(Schema.maxItems(50))),
  bcc: Schema.optional(Schema.Array(EmailAddress).pipe(Schema.maxItems(50))),
  replyTo: Schema.optional(EmailAddress),
  subject: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(998),
    Schema.filter(freeOfControlCharacters, {
      message: () => "must not contain control characters",
    }),
  ),
  /** HTML body. At least one of `html`/`text` is required. */
  html: Schema.optional(Schema.String.pipe(Schema.maxLength(5_000_000))),
  /** Plain-text body. At least one of `html`/`text` is required. */
  text: Schema.optional(Schema.String.pipe(Schema.maxLength(5_000_000))),
  attachments: Schema.optional(Schema.Array(EmailAttachment).pipe(Schema.maxItems(10))),
  headers: Schema.optional(EmailHeaders),
  /**
   * Template name the message was rendered from, when applicable. Carried on
   * logs and metrics — never the rendered subject or body.
   */
  template: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128))),
}).pipe(
  Schema.filter(
    (message) =>
      message.html !== undefined || message.text !== undefined
        ? true
        : `either html or text is required (template ${message.template ?? "none"})`,
    { identifier: "EmailMessage" },
  ),
);

export type EmailAttachmentInput = Schema.Schema.Type<typeof EmailAttachment>;
export type EmailMessageInput = Schema.Schema.Type<typeof EmailMessage>;
export type EmailMessage = EmailMessageInput;
