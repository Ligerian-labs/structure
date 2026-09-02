/**
 * `@structure-ai/mailer` — transactional email over one port: SMTP, Resend,
 * and capture drivers; typed templates with preview data; bounded
 * transient-only retry; per-driver delivery metrics; secrets stay redacted
 * and message content never reaches logs.
 */

export type {
  DriverError,
  EmailDriver,
} from "./driver.js";
export {
  type CapturedEmail,
  makeCaptureDriver,
} from "./drivers/capture.js";
export {
  makeResendDriver,
  type ResendOptions,
} from "./drivers/resend.js";
export {
  makeSmtpDriver,
  renderSmtpMessage,
  type SmtpOptions,
  stuffDots,
} from "./drivers/smtp.js";
export {
  MailDeliveryFailed,
  type MailError,
  type MailFailureClass,
  MailRejected,
  MailValidationError,
} from "./errors.js";
export {
  Mailer,
  type MailerMetrics,
  type MailerOptions,
  type MailerService,
  makeMailer,
  makeMetrics,
  type RetryOptions,
  type TemplateEnvelope,
} from "./mailer.js";
export {
  EmailAddress,
  type EmailAddressInput,
  EmailAttachment,
  type EmailAttachmentInput,
  EmailHeaders,
  EmailMessage,
  type EmailMessageInput,
} from "./message.js";
export {
  driverFromSettings,
  layerFromSettings,
  type MailerSettingsValue,
  mailerSettings,
} from "./settings.js";
export {
  defineEmailTemplate,
  type EmailTemplate,
  previewEntry,
  type RenderedEmail,
  renderPreviews,
  type TemplatePreview,
  type TemplatePreviewEntry,
} from "./templates.js";
