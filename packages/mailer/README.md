# @structure-ai/mailer

Transactional email for Effect applications behind one port: a `Mailer` service over pluggable `EmailDriver`s — SMTP (dependency-free client over `node:net`/`node:tls`), Resend and Brevo (HTTP APIs), and an in-memory capture driver for tests and local development.

Messages are schema-validated (`effect/Schema`) before any driver sees them — including CRLF-injection checks on every header field. Delivery failures are classified `transient` (SMTP 4yz, timeouts, provider 5xx/429 — retried with bounded jittered backoff) or `permanent` (SMTP 5yz, provider 4xx — fail fast). Every send is logged and measured without ever logging the subject or body.

## Quick start

```ts
import { Mailer, makeCaptureDriver } from "@structure-ai/mailer";
import { Effect } from "effect";

const MailerLive = Mailer.layer(makeCaptureDriver(), {
  defaultFrom: { email: "no-reply@example.com", name: "Example" },
});

const program = Effect.gen(function* () {
  const mailer = yield* Mailer;
  yield* mailer.send({
    from: { email: "no-reply@example.com", name: "Example" },
    to: [{ email: "user@example.com" }],
    subject: "Your export is ready",
    text: "Download it from the dashboard.",
    html: "<p>Download it from the dashboard.</p>",
  });
});
```

## Templates and the preview wall

```ts
import { defineEmailTemplate, previewEntry, renderPreviews } from "@structure-ai/mailer";

const invite = defineEmailTemplate<{ tenant: string; url: string }>(
  "invite",
  (data) => ({
    subject: `You are invited to ${data.tenant}`,
    html: `<p>Join ${data.tenant}: ${data.url}</p>`,
    text: `Join ${data.tenant}: ${data.url}`,
  }),
  { tenant: "Acme", url: "https://app.example.com/invite/preview" }, // canonical preview data
);

yield* mailer.sendTemplate(invite, {
  data: { tenant: "Globex", url: invitationUrl },
  to: [{ email: "new.user@example.com" }],
});

// Dev preview wall payload (mount on a review route or dump from a CLI):
const previews = renderPreviews([previewEntry(invite)]);
```

## Drivers

| Driver | Use | Failure classification |
| --- | --- | --- |
| `makeSmtpDriver({ host, port, user, password, tls?, allowPlaintext?, … })` | Direct SMTP relay; STARTTLS required by default (a relay that offers none is refused before AUTH with `smtp-tls-required`), `tls.mode: "implicit"` for port 465, AUTH PLAIN/LOGIN. Plaintext only to a loopback relay or with `allowPlaintext` (checked at construction). One connection per message. | 5yz → permanent, 4yz/timeouts/TLS → transient |
| `makeResendDriver({ apiKey, baseUrl? })` | Resend HTTP API over `fetch` (`fetchImpl` injectable for tests). | 4xx → permanent, 429/408/425/5xx/network → transient |
| `makeBrevoDriver({ apiKey, baseUrl? })` | Brevo transactional API (`POST /v3/smtp/email`, `api-key` header) over `fetch` (`fetchImpl` injectable for tests). Metrics label `brevo`. | 4xx → permanent, 429/408/425/5xx/network → transient |
| `makeCaptureDriver()` | Tests and dev: records every message, never fails. | — |

Attachments ride as base64 `EmailAttachment`s (≤10 MiB each, ≤10 per message); the SMTP driver renders proper `multipart/mixed` containers, RFC 2047 encoded-words for non-ASCII subjects and display names, dot-stuffed DATA payloads, and base64 transfer encoding for all bodies. Custom `headers` are emitted once, before the MIME headers, and may never carry a generated name (`From`, `To`, `Cc`, `Bcc`, `Reply-To`, `Subject`, `Date`, `Message-ID`, `MIME-Version`, `Content-*`): `EmailHeaders` refuses those keys.

## Retry and observability

`makeMailer(driver, { retry })` defaults to 3 total attempts with exponential backoff (200ms base, 10s cap, jitter) — transient failures only. Each driver label gets a bounded metric set: `mailer_<driver>_sends_total`, `mailer_<driver>_failures_total`, `mailer_<driver>_transient_failures_total`, `mailer_<driver>_duration_ms`. Log lines carry `mailerDriver`, `mailerMessageId`, `mailerTemplate`, recipient/attachment counts, and correlation ids — never subject, body, or attachment content.

## Settings

`mailerSettings` (`@structure-ai/config`) selects the driver and its credentials; secrets load `Redacted`. `MAIL_FROM` accepts either `noreply@example.com` or a display form such as `Platform <noreply@example.com>`. `layerFromSettings(settings)` parses and validates the sender before it constructs the service. It also checks the selected driver's required setting: `MAIL_SMTP_HOST` for SMTP, `MAIL_RESEND_API_KEY` for Resend, or `MAIL_BREVO_API_KEY` for Brevo.

`mailerSettings` (`@structure-ai/config`) selects the driver and its credentials; secrets load `Redacted`. `layerFromSettings(settings)` resolves and validates the combination (SMTP requires `MAIL_SMTP_HOST`, Resend requires `MAIL_RESEND_API_KEY`, Brevo requires `MAIL_BREVO_API_KEY`) before the first send. SMTP requires TLS by default: `MAIL_SMTP_TLS=starttls` upgrades before AUTH and refuses a relay that does not offer it, `implicit` speaks TLS from the first byte (set `MAIL_SMTP_PORT=465`), and `none` is accepted only for a loopback relay or with `MAIL_SMTP_ALLOW_PLAINTEXT=true`, refused at composition otherwise.

| Name | Type | Required | Default | Secret |
| --- | --- | --- | --- | --- |
| `MAIL_DRIVER` | `"capture" \| "smtp" \| "resend" \| "brevo"` | no | `capture` | |
| `MAIL_FROM` | email or `Name <email>` | no | `no-reply@localhost.invalid` | |
| `MAIL_SMTP_HOST` | string | when driver=smtp | — | |
| `MAIL_SMTP_PORT` | port | no | `587` | |
| `MAIL_SMTP_USER` | string | no | — | |
| `MAIL_SMTP_PASSWORD` | secret | no | — | yes |
| `MAIL_SMTP_TLS` | `"starttls" \| "implicit" \| "none"` | no | `starttls` | |
| `MAIL_SMTP_ALLOW_PLAINTEXT` | boolean | no | `false` | |
| `MAIL_SMTP_TLS_REJECT_UNAUTHORIZED` | boolean | no | `true` | |
| `MAIL_RESEND_API_KEY` | secret | when driver=resend | — | yes |
| `MAIL_RESEND_BASE_URL` | url (https, or http to loopback) | no | provider host | |
| `MAIL_BREVO_API_KEY` | secret | when driver=brevo | — | yes |
| `MAIL_BREVO_BASE_URL` | url (https, or http to loopback) | no | provider host | |

## Errors

`MailValidationError` (permanent — schema rejection, mapped without echoing input values), `MailRejected` (permanent — driver refusal), `MailDeliveryFailed` (transient — retried by the mailer, `retryAfterSeconds` honored when the driver supplies one).
