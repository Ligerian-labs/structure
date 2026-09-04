import { describe, expect, test } from "bun:test";
import { load } from "@structure-ai/config";
import { layerJson, layerSilent, ServiceMeta } from "@structure-ai/observability";
import { Effect, Layer, Metric, Option, Redacted } from "effect";
import type { EmailDriver } from "../src/driver.js";
import {
  defineEmailTemplate,
  driverFromSettings,
  layerFromSettings,
  MailDeliveryFailed,
  Mailer,
  MailRejected,
  mailerSettings,
  makeCaptureDriver,
  makeMailer,
} from "../src/index.js";
import type { EmailMessageInput } from "../src/message.js";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

const defined = (overrides: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined));

const message = (overrides: Record<string, unknown> = {}): EmailMessageInput =>
  ({
    from: { email: "app@example.com", name: "App" },
    to: [{ email: "ada@example.com" }],
    subject: "Your export is ready",
    text: "the export body SECRET-BODY-MARKER",
    ...defined(overrides),
  }) as EmailMessageInput;

const notice = defineEmailTemplate("notice", () => ({ subject: "Notice", text: "Hello" }), {});

describe("mailer service", () => {
  test("uses a schema-valid sender for template sends by default", async () => {
    const sent = await run(
      makeMailer(makeCaptureDriver()).sendTemplate(notice, {
        data: {},
        to: [{ email: "ada@example.com" }],
      }),
    );
    expect(sent.from).toEqual({ email: "no-reply@localhost.invalid" });
  });

  test("validates and records messages through the capture driver", async () => {
    const capture = makeCaptureDriver();
    const mailer = makeMailer(capture);
    await run(mailer.send(message()));
    expect(capture.sent).toHaveLength(1);
    expect(capture.sent[0]?.message.subject).toBe("Your export is ready");
    expect(capture.sent[0]?.message.from.email).toBe("app@example.com");
  });

  test("rejects messages without a body before reaching a driver", async () => {
    const capture = makeCaptureDriver();
    const mailer = makeMailer(capture);
    const noBody = { ...message(), ...defined({ text: null }) } as EmailMessageInput;
    delete (noBody as Record<string, unknown>).text;
    const error = await run(Effect.flip(mailer.send(noBody)));
    expect(error._tag).toBe("MailValidationError");
    expect(capture.sent).toHaveLength(0);
  });

  test("rejects header injection attempts", async () => {
    const capture = makeCaptureDriver();
    const mailer = makeMailer(capture);
    const error = await run(
      Effect.flip(mailer.send(message({ subject: "bad\r\nBcc: evil@example.com" }))),
    );
    expect(error._tag).toBe("MailValidationError");
    expect(capture.sent).toHaveLength(0);
  });

  test("retries transient failures with a bounded schedule and succeeds", async () => {
    let calls = 0;
    const flaky: EmailDriver = {
      name: "flaky",
      send: () =>
        Effect.suspend(() =>
          ++calls <= 2
            ? Effect.fail(new MailDeliveryFailed({ driver: "flaky", reason: "flaky-503" }))
            : Effect.void,
        ),
    };
    const mailer = makeMailer(flaky, {
      retry: { attempts: 3, baseDelay: "1 millis", maxDelay: "2 millis" },
    });
    await run(mailer.send(message()));
    expect(calls).toBe(3);
    const transient = await run(
      Metric.value(Metric.counter("mailer_flaky_transient_failures_total")),
    );
    expect(transient).toMatchObject({ count: 2 });
  });

  test("gives up on transient failures after the bounded attempts", async () => {
    let calls = 0;
    const down: EmailDriver = {
      name: "down",
      send: () =>
        Effect.suspend(() => {
          calls += 1;
          return Effect.fail(new MailDeliveryFailed({ driver: "down", reason: "down-timeout" }));
        }),
    };
    const mailer = makeMailer(down, { retry: { attempts: 3, baseDelay: "1 millis" } });
    const error = await run(Effect.flip(mailer.send(message())));
    expect(error._tag).toBe("MailDeliveryFailed");
    expect(calls).toBe(3);
  });

  test("does not retry permanent rejections", async () => {
    let calls = 0;
    const rejecting: EmailDriver = {
      name: "rejecting",
      send: () => {
        calls += 1;
        return Effect.fail(new MailRejected({ driver: "rejecting", reason: "smtp-550" }));
      },
    };
    const mailer = makeMailer(rejecting, { retry: { attempts: 3 } });
    const error = await run(Effect.flip(mailer.send(message())));
    expect(error._tag).toBe("MailRejected");
    expect(calls).toBe(1);
  });

  test("counts sends and final failures once per message", async () => {
    const sends = Metric.counter("mailer_counted_sends_total");
    const failures = Metric.counter("mailer_counted2_failures_total");
    const ok: EmailDriver = { name: "counted", send: () => Effect.void };
    const bad: EmailDriver = {
      name: "counted2",
      send: () => Effect.fail(new MailDeliveryFailed({ driver: "counted2", reason: "x" })),
    };
    await run(makeMailer(ok).send(message()));
    await run(
      Effect.flip(
        makeMailer(bad, { retry: { attempts: 2, baseDelay: "1 millis" } }).send(message()),
      ),
    );
    expect(await run(Metric.value(sends))).toMatchObject({ count: 1 });
    expect(await run(Metric.value(failures))).toMatchObject({ count: 1 });
  });

  test("never writes subject or body to logs", async () => {
    const lines: Array<string> = [];
    const failing: EmailDriver = {
      name: "leaky",
      send: () => Effect.fail(new MailRejected({ driver: "leaky", reason: "smtp-554" })),
    };
    const capture = makeCaptureDriver();
    const loggerLayer = layerJson((line) => {
      lines.push(line);
    }).pipe(Layer.provide(ServiceMeta.layer({ name: "mailer-test" })));
    await run(
      Effect.provide(
        Effect.flip(makeMailer(failing).send(message({ subject: "SECRET-SUBJECT-XYZ" }))),
        loggerLayer,
      ),
    );
    await run(Effect.provide(makeMailer(capture).send(message()), layerSilent));
    const logged = lines.join("\n");
    expect(logged).toContain("mailer send failed");
    expect(logged).toContain("smtp-554");
    expect(logged).not.toContain("SECRET-SUBJECT-XYZ");
    expect(logged).not.toContain("SECRET-BODY-MARKER");
  });
});

describe("mailer settings", () => {
  test("loads with driver+host and keeps secrets redacted", async () => {
    const settings = await run(
      load(mailerSettings, {
        overrides: {
          MAIL_DRIVER: "smtp",
          MAIL_SMTP_HOST: "smtp.internal",
          MAIL_SMTP_USER: "mailer",
          MAIL_SMTP_PASSWORD: "hunter2",
        },
      }),
    );
    expect(settings.driver).toBe("smtp");
    expect(settings.smtpHost).toEqual(Option.some("smtp.internal"));
    expect(settings.smtpPassword).toEqual(Option.some(Redacted.make("hunter2")));
    expect(String(settings.smtpPassword)).not.toContain("hunter2");
  });

  test("rejects smtp selection without a host at composition time", async () => {
    const settings = await run(load(mailerSettings, { overrides: { MAIL_DRIVER: "smtp" } }));
    const error = await run(Effect.flip(driverFromSettings(settings)));
    expect(error._tag).toBe("MailValidationError");
  });

  test("rejects brevo selection without an api key at composition time", async () => {
    const settings = await run(load(mailerSettings, { overrides: { MAIL_DRIVER: "brevo" } }));
    const error = await run(Effect.flip(driverFromSettings(settings)));
    expect(error._tag).toBe("MailValidationError");
    if (error._tag === "MailValidationError") expect(error.field).toBe("MAIL_BREVO_API_KEY");
    const layerError = await run(Effect.flip(Effect.provide(Mailer, layerFromSettings(settings))));
    expect(layerError._tag).toBe("MailValidationError");
  });

  test("resolves the brevo driver from its key and keeps it redacted", async () => {
    const settings = await run(
      load(mailerSettings, {
        overrides: {
          MAIL_DRIVER: "brevo",
          MAIL_BREVO_API_KEY: "xkeysib-secret",
          MAIL_BREVO_BASE_URL: "https://brevo.test",
        },
      }),
    );
    expect(settings.brevoApiKey).toEqual(Option.some(Redacted.make("xkeysib-secret")));
    expect(String(settings.brevoApiKey)).not.toContain("xkeysib-secret");
    const driver = await run(driverFromSettings(settings));
    expect(driver.name).toBe("brevo");
  });

  test("MAIL_SMTP_TLS=none towards a non-loopback relay is refused at composition", async () => {
    const settings = await run(
      load(mailerSettings, {
        overrides: {
          MAIL_DRIVER: "smtp",
          MAIL_SMTP_HOST: "relay.example.com",
          MAIL_SMTP_TLS: "none",
        },
      }),
    );
    const error = await run(Effect.flip(driverFromSettings(settings)));
    expect(error._tag).toBe("MailValidationError");
    if (error._tag === "MailValidationError") expect(error.field).toBe("MAIL_SMTP_TLS");
  });

  test("MAIL_SMTP_ALLOW_PLAINTEXT=true or a loopback relay accepts MAIL_SMTP_TLS=none", async () => {
    const optedIn = await run(
      load(mailerSettings, {
        overrides: {
          MAIL_DRIVER: "smtp",
          MAIL_SMTP_HOST: "relay.example.com",
          MAIL_SMTP_TLS: "none",
          MAIL_SMTP_ALLOW_PLAINTEXT: "true",
        },
      }),
    );
    expect((await run(driverFromSettings(optedIn))).name).toBe("smtp");
    const loopback = await run(
      load(mailerSettings, {
        overrides: { MAIL_DRIVER: "smtp", MAIL_SMTP_HOST: "localhost", MAIL_SMTP_TLS: "none" },
      }),
    );
    expect((await run(driverFromSettings(loopback))).name).toBe("smtp");
  });

  test("smtp settings default to STARTTLS with certificate verification and no plaintext", async () => {
    const settings = await run(
      load(mailerSettings, {
        overrides: { MAIL_DRIVER: "smtp", MAIL_SMTP_HOST: "relay.example.com" },
      }),
    );
    expect(settings.smtpTls).toBe("starttls");
    expect(settings.smtpAllowPlaintext).toBe(false);
    expect(settings.smtpTlsRejectUnauthorized).toBe(true);
  });

test("layerFromSettings resolves a capture driver with a schema-valid sender by default", async () => {
    const settings = await run(load(mailerSettings, { overrides: {} }));
    const service = await run(Effect.provide(Mailer, layerFromSettings(settings)));
    const sent = await run(
      service.sendTemplate(notice, { data: {}, to: [{ email: "cap@example.com" }] }),
    );
    expect(sent.from).toEqual({ email: "no-reply@localhost.invalid" });
  });

  test("layerFromSettings parses a display name from MAIL_FROM", async () => {
    const settings = await run(
      load(mailerSettings, {
        overrides: { MAIL_FROM: "Platform <noreply@mail.example.com>" },
      }),
    );
    const service = await run(Effect.provide(Mailer, layerFromSettings(settings)));
    const sent = await run(
      service.sendTemplate(notice, { data: {}, to: [{ email: "cap@example.com" }] }),
    );
    expect(sent.from).toEqual({ email: "noreply@mail.example.com", name: "Platform" });
  });

  test.each([
    "not-an-address",
    "Platform, Support <noreply@mail.example.com>",
    "Platform\r\nBcc: attacker@example.com <noreply@mail.example.com>",
  ])("layerFromSettings rejects invalid MAIL_FROM %p at composition time", async (from) => {
    const settings = await run(load(mailerSettings, { overrides: { MAIL_FROM: from } }));
    const error = await run(Effect.flip(Effect.provide(Mailer, layerFromSettings(settings))));
    expect(error._tag).toBe("MailValidationError");
    if (error._tag === "MailValidationError") expect(error.field).toBe("MAIL_FROM");
  });
});
