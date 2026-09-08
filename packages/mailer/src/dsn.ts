import { Effect, Option, Redacted } from "effect";
import type { EmailDriver } from "./driver.js";
import { makeBrevoDriver } from "./drivers/brevo.js";
import { makeResendDriver } from "./drivers/resend.js";
import {
  makeSmtpDriver,
  type SmtpOptions,
  type SmtpTlsMode,
  validateSmtpOptions,
} from "./drivers/smtp.js";
import { MailValidationError } from "./errors.js";

/** The API-key DSN schemes share one parsed shape; the scheme picks the factory. */
export type ApiDsnScheme = "resend+api" | "brevo+api";

/**
 * A parsed Symfony-compatible mailer DSN. Credentials live only in
 * `Redacted` values; nothing here is ever logged.
 */
export type MailerDsn =
  | {
      readonly kind: "smtp";
      readonly host: string;
      /** Explicit port from the DSN; `None` lets the driver default (587/465 by TLS mode). */
      readonly port: Option.Option<number>;
      readonly user?: string;
      readonly password?: Redacted.Redacted<string>;
      readonly tls: SmtpTlsMode;
      /** Query `?local_domain=` — the EHLO identifier. */
      readonly hostname?: string;
      /** Query `?verify_peer=false` disables certificate verification. */
      readonly rejectUnauthorized: boolean;
      /** Query `?allow_plaintext=true` opts into cleartext to a non-loopback relay. */
      readonly allowPlaintext: boolean;
    }
  | {
      readonly kind: "api";
      readonly scheme: ApiDsnScheme;
      readonly apiKey: Redacted.Redacted<string>;
      /** Query `?base_url=` override. */
      readonly baseUrl?: string;
    };

const SMTP_SCHEMES: ReadonlySet<string> = new Set(["smtp:", "smtps:", "resend+smtp:"]);
const API_SCHEMES: ReadonlySet<string> = new Set(["resend+api:", "brevo+api:"]);

const invalid = (reason: string): MailValidationError =>
  new MailValidationError({ field: "MAILER_DSN", reason });

/** `new URL` is not total: lift it into the Effect channel instead of throwing. */
const parseUrl = (dsn: string): Effect.Effect<URL, MailValidationError> =>
  Effect.try({
    try: () => new URL(dsn),
    catch: () =>
      invalid(
        "must be a valid URL with one of the schemes smtp://, smtps://, resend+api://, resend+smtp://, brevo+api://",
      ),
  });

/** `decodeURIComponent` is not total (lone surrogates); keep the raw value then. */
const decodeComponent = (value: string): string =>
  Effect.runSync(Effect.try({ try: () => decodeURIComponent(value), catch: () => value }));

const isLoopbackUrl = (baseUrl: string): boolean => {
  const host = Effect.runSync(
    Effect.try({ try: () => new URL(baseUrl).hostname, catch: () => "" }),
  );
  return host === "localhost" || /^127(?:\.\d{1,3}){3}$/u.test(host);
};

/**
 * Parses a Symfony `MAILER_DSN`-compatible URL into a typed description of
 * the driver it selects. Supported schemes: `smtp://` (STARTTLS), `smtps://`
 * (implicit TLS), `resend+api://`, `resend+smtp://` (implicit TLS on port
 * 465/2465 relays), and `brevo+api://`. Credentials come from the userinfo
 * (percent-encoded, as Symfony writes them) and stay `Redacted`. Every
 * malformed input fails with `MailValidationError` (permanent) instead of
 * throwing.
 */
export const parseMailerDsn = (dsn: string): Effect.Effect<MailerDsn, MailValidationError> =>
  Effect.gen(function* () {
    const url = yield* parseUrl(dsn);
    if (!SMTP_SCHEMES.has(url.protocol) && !API_SCHEMES.has(url.protocol)) {
      return yield* Effect.fail(invalid(`unsupported scheme ${url.protocol}`));
    }
    if (url.hostname.length === 0) {
      return yield* Effect.fail(invalid("must name a host"));
    }
    if (url.password.length > 0 && url.username.length === 0) {
      return yield* Effect.fail(invalid("password without a username"));
    }
    const query = url.searchParams;
    for (const key of query.keys()) {
      if (key === "password" || key === "api_key" || key === "apikey") {
        return yield* Effect.fail(
          invalid(`credentials belong in the userinfo (scheme://user:pass@host), not ?${key}=`),
        );
      }
    }

    if (API_SCHEMES.has(url.protocol)) {
      if (url.username.length === 0) {
        return yield* Effect.fail(
          invalid("the API key is the userinfo (resend+api://KEY@default)"),
        );
      }
      const baseUrl = query.get("base_url") ?? undefined;
      const secure =
        baseUrl === undefined ||
        baseUrl.startsWith("https://") ||
        (baseUrl.startsWith("http://") && isLoopbackUrl(baseUrl));
      if (!secure) {
        return yield* Effect.fail(
          invalid(
            "base_url must be https (http only for a loopback host): the API key and every message are sent to it",
          ),
        );
      }
      return {
        kind: "api",
        scheme: url.protocol === "brevo+api:" ? "brevo+api" : "resend+api",
        apiKey: Redacted.make(decodeComponent(url.username)),
        ...(baseUrl === undefined ? {} : { baseUrl }),
      } satisfies MailerDsn;
    }

    const port = url.port.length > 0 ? Option.some(Number(url.port)) : Option.none();
    if (
      Option.isSome(port) &&
      (!Number.isInteger(port.value) || port.value <= 0 || port.value > 65535)
    ) {
      return yield* Effect.fail(invalid("port must be an integer between 1 and 65535"));
    }
    // WHATWG URLs fold everything before the LAST "@" into the username (the
    // embedded "@" survives percent-encoded as `%40`), so Symfony's documented
    // `resend+smtp://resend@KEY@smtp.resend.com` spelling arrives as username
    // `resend%40KEY` with no password — split it back apart.
    const ENCODED_AT = "%40";
    const credentials =
      url.password.length > 0 || !url.username.includes(ENCODED_AT)
        ? { user: url.username, password: url.password }
        : {
            user: url.username.slice(0, url.username.lastIndexOf(ENCODED_AT)),
            password: url.username.slice(url.username.lastIndexOf(ENCODED_AT) + ENCODED_AT.length),
          };
    const hostname = query.get("local_domain") ?? undefined;
    return {
      kind: "smtp",
      host: url.hostname,
      port,
      ...(credentials.user.length > 0 ? { user: decodeComponent(credentials.user) } : {}),
      ...(credentials.password.length > 0
        ? { password: Redacted.make(decodeComponent(credentials.password)) }
        : {}),
      tls: url.protocol === "smtp:" ? "starttls" : "implicit",
      ...(hostname === undefined ? {} : { hostname }),
      rejectUnauthorized: query.get("verify_peer") !== "false",
      allowPlaintext: query.get("allow_plaintext") === "true",
    } satisfies MailerDsn;
  });

/** Driver construction is factored out so tests and hosts can intercept it. */
export interface DsnDriverFactories {
  readonly smtp: (options: SmtpOptions) => EmailDriver;
  readonly api: (
    scheme: ApiDsnScheme,
    apiKey: Redacted.Redacted<string>,
    baseUrl?: string,
  ) => EmailDriver;
}

export const defaultDsnDriverFactories: DsnDriverFactories = {
  smtp: makeSmtpDriver,
  api: (scheme, apiKey, baseUrl) =>
    scheme === "brevo+api"
      ? makeBrevoDriver({ apiKey, ...(baseUrl === undefined ? {} : { baseUrl }) })
      : makeResendDriver({ apiKey, ...(baseUrl === undefined ? {} : { baseUrl }) }),
};

/**
 * Builds the driver a DSN selects, validating transport security exactly as
 * `driverFromSettings` does for explicit options: a cleartext session
 * (`smtp://` without STARTTLS available is handled at send time; `?allow_plaintext=true`
 * towards a non-loopback relay without TLS is refused here). Credentials stay
 * `Redacted` end to end; nothing throws.
 */
export const driverFromDsn = (
  dsn: string,
  factories: DsnDriverFactories = defaultDsnDriverFactories,
): Effect.Effect<EmailDriver, MailValidationError> =>
  Effect.gen(function* () {
    const parsed = yield* parseMailerDsn(dsn);
    switch (parsed.kind) {
      case "api":
        return factories.api(parsed.scheme, parsed.apiKey, parsed.baseUrl);
      case "smtp": {
        const options: SmtpOptions = {
          host: parsed.host,
          ...(Option.isSome(parsed.port) ? { port: parsed.port.value } : {}),
          ...(parsed.user !== undefined ? { user: parsed.user } : {}),
          ...(parsed.password !== undefined ? { password: parsed.password } : {}),
          ...(parsed.hostname !== undefined ? { hostname: parsed.hostname } : {}),
          tls: {
            mode: parsed.tls,
            rejectUnauthorized: parsed.rejectUnauthorized,
          },
          allowPlaintext: parsed.allowPlaintext,
        };
        const refusal = validateSmtpOptions(options);
        if (refusal !== undefined) return yield* Effect.fail(refusal);
        return factories.smtp(options);
      }
    }
  });
