import { describe, expect, test } from "bun:test";
import { load } from "@structure-ai/config";
import { layerJson, layerSilent, ServiceMeta } from "@structure-ai/observability";
import { Effect, Layer, Metric, Option, Redacted } from "effect";
import type { EmailDriver } from "../src/driver.js";
import {
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

describe("mailer service", () => {
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

  test("layerFromSettings resolves a capture driver by default", async () => {
    const settings = await run(load(mailerSettings, { overrides: {} }));
    const service = await run(Effect.provide(Mailer, layerFromSettings(settings)));
    await run(service.send(message({ to: [{ email: "cap@example.com" }] })));
  });
});
