import { Settings } from "@structure-ai/config";
import { type Config, Effect, Layer, Option } from "effect";
import type { EmailDriver } from "./driver.js";
import { makeCaptureDriver } from "./drivers/capture.js";
import { makeResendDriver } from "./drivers/resend.js";
import { makeSmtpDriver } from "./drivers/smtp.js";
import { MailValidationError } from "./errors.js";
import { Mailer, type MailerOptions, makeMailer } from "./mailer.js";

/**
 * Standard mailer settings — flat, validated at load time. Secrets
 * (`MAIL_SMTP_PASSWORD`, `MAIL_RESEND_API_KEY`) load as `Redacted` values.
 * Nest under a prefix with `Settings.nested("APP", mailerSettings)` when the
 * host app needs its own namespace.
 */
export const mailerSettings = Settings.struct({
  driver: Settings.literal("MAIL_DRIVER", ["capture", "smtp", "resend"], {
    description: "outbound driver: smtp, resend, or capture (records in memory)",
    default: "capture",
  }),
  from: Settings.string("MAIL_FROM", {
    description: "default From address for template sends",
    default: "no-reply@localhost",
  }),
  smtpHost: Settings.optional(
    Settings.string("MAIL_SMTP_HOST", { description: "SMTP relay host (required for smtp)" }),
  ),
  smtpPort: Settings.port("MAIL_SMTP_PORT", {
    description: "SMTP relay port",
    default: 587,
  }),
  smtpUser: Settings.optional(
    Settings.string("MAIL_SMTP_USER", { description: "SMTP AUTH username" }),
  ),
  smtpPassword: Settings.optional(
    Settings.secret("MAIL_SMTP_PASSWORD", { description: "SMTP AUTH password" }),
  ),
  resendApiKey: Settings.optional(
    Settings.secret("MAIL_RESEND_API_KEY", {
      description: "Resend API key (required for resend)",
    }),
  ),
  resendBaseUrl: Settings.optional(
    Settings.url("MAIL_RESEND_BASE_URL", { description: "Resend API base URL override" }),
  ),
});

/** The loaded value type of {@link mailerSettings}. */
export type MailerSettingsValue =
  (typeof mailerSettings)["config"] extends Config.Config<infer A> ? A : never;

const missing = (setting: string): MailValidationError =>
  new MailValidationError({ field: setting, reason: "is required for the selected driver" });

/**
 * Builds the driver a `mailerSettings` value selects, validating the
 * combination (smtp needs a host; resend needs an API key) — misconfiguration
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
          onSome: (host) =>
            Effect.succeed(
              makeSmtpDriver({
                host,
                port: settings.smtpPort,
                ...(Option.isSome(settings.smtpUser)
                  ? { user: Option.getOrThrow(settings.smtpUser) }
                  : {}),
                ...(Option.isSome(settings.smtpPassword)
                  ? { password: Option.getOrThrow(settings.smtpPassword) }
                  : {}),
              }),
            ),
        });
      case "resend":
        return yield* Option.match(settings.resendApiKey, {
          onNone: () => Effect.fail(missing("MAIL_RESEND_API_KEY")),
          onSome: (apiKey) =>
            Effect.succeed(
              makeResendDriver({
                apiKey,
                ...(Option.isSome(settings.resendBaseUrl)
                  ? { baseUrl: Option.getOrThrow(settings.resendBaseUrl).toString() }
                  : {}),
              }),
            ),
        });
    }
  });

/**
 * `Mailer` layer from already-loaded settings: resolves and validates the
 * driver, applies the default `From`, and wires the standard retry policy.
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
    Effect.map(driverFromSettings(settings), (driver) =>
      makeMailer(driver, {
        defaultFrom: { email: settings.from },
        ...(options?.retry === undefined ? {} : { retry: options.retry }),
      }),
    ),
  );
