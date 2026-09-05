import { Settings } from "@structure-ai/config";
import { type Config, Effect, Layer, Option, Schema } from "effect";
import type { EmailDriver } from "./driver.js";
import { makeBrevoDriver } from "./drivers/brevo.js";
import { makeCaptureDriver } from "./drivers/capture.js";
import { makeResendDriver } from "./drivers/resend.js";
import { isLoopbackHost, makeSmtpDriver, validateSmtpOptions } from "./drivers/smtp.js";
import { MailValidationError } from "./errors.js";
import { Mailer, type MailerOptions, makeMailer } from "./mailer.js";
import {
  defaultFromAddress,
  EmailAddress,
  type EmailAddressInput,
  freeOfControlCharacters,
} from "./message.js";

/**
 * Standard mailer settings — flat, validated at load time. Secrets
 * (`MAIL_SMTP_PASSWORD`, `MAIL_RESEND_API_KEY`, `MAIL_BREVO_API_KEY`) load as
 * `Redacted` values.
 * Nest under a prefix with `Settings.nested("APP", mailerSettings)` when the
 * host app needs its own namespace.
 */
export const mailerSettings = Settings.struct({
  driver: Settings.literal("MAIL_DRIVER", ["capture", "smtp", "resend", "brevo"], {
    description: "outbound driver: smtp, resend, brevo, or capture (records in memory)",
    default: "capture",
  }),
  from: Settings.string("MAIL_FROM", {
    description:
      "default From address for template sends, as addr@example.com or Name <addr@example.com>",
    default: defaultFromAddress.email,
  }),
  smtpHost: Settings.optional(
    Settings.string("MAIL_SMTP_HOST", { description: "SMTP relay host (required for smtp)" }),
  ),
  smtpPort: Settings.optional(
    Settings.port("MAIL_SMTP_PORT", {
      description: "SMTP relay port (default 587, or 465 when MAIL_SMTP_TLS=implicit)",
    }),
  ),
  smtpUser: Settings.optional(
    Settings.string("MAIL_SMTP_USER", { description: "SMTP AUTH username" }),
  ),
  smtpPassword: Settings.optional(
    Settings.secret("MAIL_SMTP_PASSWORD", { description: "SMTP AUTH password" }),
  ),
  smtpTls: Settings.literal("MAIL_SMTP_TLS", ["starttls", "implicit", "none"], {
    description:
      "SMTP transport security: starttls (upgrade before AUTH, required unless the relay is loopback), implicit (TLS from the first byte, port 465 unless MAIL_SMTP_PORT says otherwise), none (cleartext; needs MAIL_SMTP_ALLOW_PLAINTEXT for a non-loopback relay)",
    default: "starttls",
  }),
  smtpAllowPlaintext: Settings.boolean("MAIL_SMTP_ALLOW_PLAINTEXT", {
    description:
      "accept a cleartext SMTP session to a non-loopback relay (credentials and messages unencrypted)",
    default: false,
  }),
  smtpTlsRejectUnauthorized: Settings.boolean("MAIL_SMTP_TLS_REJECT_UNAUTHORIZED", {
    description: "verify the relay's TLS certificate chain",
    default: true,
  }),
  resendApiKey: Settings.optional(
    Settings.secret("MAIL_RESEND_API_KEY", {
      description: "Resend API key (required for resend)",
    }),
  ),
  resendBaseUrl: Settings.optional(
    Settings.url("MAIL_RESEND_BASE_URL", {
      description: "Resend API base URL override (https, or http to a loopback stub)",
    }),
  ),
  brevoApiKey: Settings.optional(
    Settings.secret("MAIL_BREVO_API_KEY", {
      description: "Brevo API key (required for brevo)",
    }),
  ),
  brevoBaseUrl: Settings.optional(
    Settings.url("MAIL_BREVO_BASE_URL", {
      description: "Brevo API base URL override (https, or http to a loopback stub)",
    }),
  ),
});

/** The loaded value type of {@link mailerSettings}. */
export type MailerSettingsValue =
  (typeof mailerSettings)["config"] extends Config.Config<infer A> ? A : never;

const missing = (setting: string): MailValidationError =>
  new MailValidationError({ field: setting, reason: "is required for the selected driver" });

const invalidFrom = (): MailValidationError =>
  new MailValidationError({ field: "MAIL_FROM", reason: "must be an email or Name <email>" });

const parseFrom = (value: string): Effect.Effect<EmailAddressInput, MailValidationError> => {
  const input = value.trim();
  const open = input.indexOf("<");
  const close = input.lastIndexOf(">");
  let candidate: EmailAddressInput;

  if (open === -1 && close === -1) {
    candidate = { email: input };
  } else {
    const name = input.slice(0, open).trim();
    const email = input.slice(open + 1, close).trim();
    const hasOneAddress =
      open > 0 &&
      close === input.length - 1 &&
      input.lastIndexOf("<") === open &&
      input.indexOf(">") === close;
    const safeName =
      name.length > 0 &&
      freeOfControlCharacters(name) &&
      !name.includes(",") &&
      !name.includes(";");
    if (!hasOneAddress || !safeName) return Effect.fail(invalidFrom());
    candidate = { email, name };
  }

  return Schema.decodeUnknown(EmailAddress)(candidate).pipe(Effect.mapError(invalidFrom));
};

/**
 * A provider base URL carries the API key and every message to whatever it
 * names: it must be https, except http to a loopback host (a local stub).
 */
const providerBaseUrl = (
  setting: string,
  value: Option.Option<URL>,
): Effect.Effect<{ readonly baseUrl?: string }, MailValidationError> => {
  if (Option.isNone(value)) return Effect.succeed({});
  const url = value.value;
  const secure =
    url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname));
  return secure
    ? Effect.succeed({ baseUrl: url.toString().replace(/\/$/u, "") })
    : Effect.fail(
        new MailValidationError({
          field: setting,
          reason:
            "must be an https URL (http is accepted for a loopback host only): the API key and every message are sent to it",
        }),
      );
};

/**
 * Builds the driver a `mailerSettings` value selects, validating the
 * combination (smtp needs a host; resend and brevo need an API key) — misconfiguration
 * fails with a typed error at composition, before the first send.
 */
export const driverFromSettings = (
  settings: MailerSettingsValue,
): Effect.Effect<EmailDriver, MailValidationError> =>
  Effect.gen(function* () {
    switch (settings.driver) {
      case "capture":
        return makeCaptureDriver();
      case "smtp":
        return yield* Option.match(settings.smtpHost, {
          onNone: () => Effect.fail(missing("MAIL_SMTP_HOST")),
          onSome: (host) => {
            const options = {
              host,
              ...(Option.isSome(settings.smtpPort)
                ? { port: Option.getOrThrow(settings.smtpPort) }
                : {}),
              ...(Option.isSome(settings.smtpUser)
                ? { user: Option.getOrThrow(settings.smtpUser) }
                : {}),
              ...(Option.isSome(settings.smtpPassword)
                ? { password: Option.getOrThrow(settings.smtpPassword) }
                : {}),
              tls: {
                mode: settings.smtpTls,
                rejectUnauthorized: settings.smtpTlsRejectUnauthorized,
              },
              allowPlaintext: settings.smtpAllowPlaintext,
            };
            const invalid = validateSmtpOptions(options);
            return invalid === undefined
              ? Effect.succeed(makeSmtpDriver(options))
              : Effect.fail(
                  new MailValidationError({
                    field: "MAIL_SMTP_TLS",
                    reason: `"none" would send credentials and messages to ${host} in cleartext; set MAIL_SMTP_ALLOW_PLAINTEXT=true to accept that for a non-loopback relay`,
                  }),
                );
          },
        });
      case "resend":
        return yield* Option.match(settings.resendApiKey, {
          onNone: () => Effect.fail(missing("MAIL_RESEND_API_KEY")),
          onSome: (apiKey) =>
            Effect.map(providerBaseUrl("MAIL_RESEND_BASE_URL", settings.resendBaseUrl), (base) =>
              makeResendDriver({ apiKey, ...base }),
            ),
        });
      case "brevo":
        return yield* Option.match(settings.brevoApiKey, {
          onNone: () => Effect.fail(missing("MAIL_BREVO_API_KEY")),
          onSome: (apiKey) =>
            Effect.map(providerBaseUrl("MAIL_BREVO_BASE_URL", settings.brevoBaseUrl), (base) =>
              makeBrevoDriver({ apiKey, ...base }),
            ),
        });
    }
  });

/**
 * `Mailer` layer from already-loaded settings: parses and validates the
 * default `From`, resolves the driver, and wires the standard retry policy.
 *
 * ```ts
 * const MailerLive = layerFromSettings(settings);
 * ```
 */
export const layerFromSettings = (
  settings: MailerSettingsValue,
  options?: MailerOptions,
): Layer.Layer<Mailer, MailValidationError> =>
  Layer.effect(
    Mailer,
    Effect.gen(function* () {
      const defaultFrom = yield* parseFrom(settings.from);
      const driver = yield* driverFromSettings(settings);
      return makeMailer(driver, {
        defaultFrom,
        ...(options?.retry === undefined ? {} : { retry: options.retry }),
      });
    }),
  );
