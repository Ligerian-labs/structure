import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as tls from "node:tls";
import { load } from "@structure-ai/config";
import { Effect, Option, Redacted } from "effect";
import type { EmailDriver } from "../src/driver.js";
import type { SmtpOptions } from "../src/index.js";
import { driverFromDsn, driverFromSettings, mailerSettings, parseMailerDsn } from "../src/index.js";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

/** Reads the SmtpOptions a dsn-built driver would connect with, via the injectable factory. */
const smtpOptionsOf = async (
  dsn: string,
): Promise<{ name: string; options: SmtpOptions } | { name: string }> => {
  let captured: SmtpOptions | undefined;
  const factory = {
    smtp: (options: SmtpOptions): EmailDriver => {
      captured = options;
      return { name: "smtp", send: () => Effect.void };
    },
    api: (scheme: "resend+api" | "brevo+api"): EmailDriver => ({
      name: scheme === "brevo+api" ? "brevo" : "resend",
      send: () => Effect.void,
    }),
  };
  const driver = await run(driverFromDsn(dsn, factory));
  return captured === undefined ? { name: driver.name } : { name: driver.name, options: captured };
};

describe("parseMailerDsn", () => {
  test("parses smtp:// with user info, default port 587, starttls", async () => {
    const parsed = await run(parseMailerDsn("smtp://mailer:secret@smtp.example.com:2525"));
    expect(parsed.kind).toBe("smtp");
    if (parsed.kind !== "smtp") throw new Error("unreachable");
    expect(parsed.host).toBe("smtp.example.com");
    expect(parsed.port).toEqual(Option.some(2525));
    expect(parsed.user).toBe("mailer");
    expect(Redacted.value(parsed.password ?? Redacted.make(""))).toBe("secret");
    expect(parsed.tls).toBe("starttls");
  });

  test("defaults the port when absent: 587 for smtp, 465 for smtps", async () => {
    const smtp = await run(parseMailerDsn("smtp://smtp.example.com"));
    expect(smtp.kind).toBe("smtp");
    if (smtp.kind !== "smtp") throw new Error("unreachable");
    expect(smtp.port).toEqual(Option.none());

    const smtps = await run(parseMailerDsn("smtps://smtp.example.com"));
    expect(smtps.kind).toBe("smtp");
    if (smtps.kind !== "smtp") throw new Error("unreachable");
    expect(smtps.tls).toBe("implicit");
    expect(smtps.port).toEqual(Option.none());
  });

  test("percent-decodes credentials without ever logging them", async () => {
    const parsed = await run(
      parseMailerDsn("smtp://team%40example.com:p%40ss%20word@smtp.example.com"),
    );
    expect(parsed.kind).toBe("smtp");
    if (parsed.kind !== "smtp") throw new Error("unreachable");
    expect(parsed.user).toBe("team@example.com");
    expect(Redacted.value(parsed.password ?? Redacted.make(""))).toBe("p@ss word");
  });

  test("resend+api:// selects the HTTP driver and keeps the key redacted", async () => {
    const parsed = await run(parseMailerDsn("resend+api://re_secret@default"));
    expect(parsed.kind).toBe("api");
    if (parsed.kind !== "api") throw new Error("unreachable");
    expect(parsed.scheme).toBe("resend+api");
    expect(Redacted.value(parsed.apiKey)).toBe("re_secret");
  });

  test("resend+smtp:// is the resend host with SMTP AUTH credentials", async () => {
    const parsed = await run(parseMailerDsn("resend+smtp://resend@re_secret@smtp.resend.com:2465"));
    expect(parsed.kind).toBe("smtp");
    if (parsed.kind !== "smtp") throw new Error("unreachable");
    expect(parsed.host).toBe("smtp.resend.com");
    expect(parsed.port).toEqual(Option.some(2465));
    expect(parsed.user).toBe("resend");
    expect(Redacted.value(parsed.password ?? Redacted.make(""))).toBe("re_secret");
    expect(parsed.tls).toBe("implicit");
  });

  test("rejects unsupported schemes with a typed validation error naming the field", async () => {
    const error = await run(Effect.flip(parseMailerDsn("sendmail://native")));
    expect(error._tag).toBe("MailValidationError");
    if (error._tag === "MailValidationError") expect(error.field).toBe("MAILER_DSN");
  });

  test("rejects a missing host", async () => {
    const error = await run(Effect.flip(parseMailerDsn("smtp://:2525")));
    expect(error._tag).toBe("MailValidationError");
  });

  test("rejects credentials in the query string (smtp hosts must carry them in userinfo)", async () => {
    const error = await run(Effect.flip(parseMailerDsn("smtp://smtp.example.com?password=x")));
    expect(error._tag).toBe("MailValidationError");
  });
});

describe("driverFromDsn", () => {
  test("smtp:// produces the smtp driver with the DSN's options", async () => {
    const result = await smtpOptionsOf("smtp://mailer:pw@relay.example.com:2525");
    expect(result.name).toBe("smtp");
    if (!("options" in result)) throw new Error("smtp options not captured");
    expect(result.options.host).toBe("relay.example.com");
    expect(result.options.port).toBe(2525);
    expect(result.options.user).toBe("mailer");
  });

  test("smtps:// produces implicit TLS and port 465 by default", async () => {
    const result = await smtpOptionsOf("smtps://relay.example.com");
    expect(result.name).toBe("smtp");
    if (!("options" in result)) throw new Error("smtp options not captured");
    expect(result.options.tls?.mode).toBe("implicit");
    expect(result.options.port).toBeUndefined();
  });

  test("resend+api:// produces the resend driver, never an smtp one", async () => {
    const result = await smtpOptionsOf("resend+api://key@default");
    expect(result.name).toBe("resend");
    if ("options" in result) throw new Error("no smtp options expected");
  });

  test("smuggled credentials never appear in the error channel", async () => {
    const error = await run(
      Effect.flip(driverFromDsn("smtp://user:hunter2@relay.example.com?password=leak")),
    );
    expect(error._tag).toBe("MailValidationError");
    if (error._tag === "MailValidationError") {
      expect(error.field).toBe("MAILER_DSN");
      expect(error.message).not.toContain("hunter2");
      expect(error.message).not.toContain("leak");
    }
  });
});

describe("MAILER_DSN setting", () => {
  test("loads as a redacted secret", async () => {
    const settings = await run(
      load(mailerSettings, { overrides: { MAILER_DSN: "smtp://u:p@relay.example.com" } }),
    );
    expect(settings.dsn).toEqual(Option.some(Redacted.make("smtp://u:p@relay.example.com")));
    expect(String(settings.dsn)).not.toContain("p@relay");
  });

  test("takes precedence over per-driver settings when set", async () => {
    const settings = await run(
      load(mailerSettings, {
        overrides: {
          MAILER_DSN: "resend+api://re_secret@default",
          MAIL_DRIVER: "smtp",
          MAIL_SMTP_HOST: "smtp.internal",
        },
      }),
    );
    const driver = await run(driverFromSettings(settings));
    expect(driver.name).toBe("resend");
  });

  test("falls back to per-driver settings when unset", async () => {
    const settings = await run(
      load(mailerSettings, {
        overrides: { MAIL_DRIVER: "smtp", MAIL_SMTP_HOST: "smtp.internal" },
      }),
    );
    const driver = await run(driverFromSettings(settings));
    expect(driver.name).toBe("smtp");
  });

  test("an invalid DSN fails at composition through the typed error channel", async () => {
    const settings = await run(
      load(mailerSettings, { overrides: { MAILER_DSN: "gopher://relay" } }),
    );
    const error = await run(Effect.flip(driverFromSettings(settings)));
    expect(error._tag).toBe("MailValidationError");
    if (error._tag === "MailValidationError") expect(error.field).toBe("MAILER_DSN");
  });

  test("a DSN can opt into plaintext and skip peer verification through query parameters", async () => {
    const result = await smtpOptionsOf("smtp://relay.example.com?allow_plaintext=true");
    if (!("options" in result)) throw new Error("smtp options not captured");
    expect(result.options.allowPlaintext).toBe(true);
    const relaxed = await smtpOptionsOf("smtps://relay.example.com?verify_peer=false");
    if (!("options" in relaxed)) throw new Error("smtp options not captured");
    expect(relaxed.options.tls?.rejectUnauthorized).toBe(false);
    expect(relaxed.options.tls?.mode).toBe("implicit");
  });

  test("resend+smtp:// is implicit TLS by default (465-style relays)", async () => {
    const result = await smtpOptionsOf("resend+smtp://resend:key@smtp.resend.com:2465");
    expect(result.name).toBe("smtp");
    if (!("options" in result)) throw new Error("smtp options not captured");
    expect(result.options.host).toBe("smtp.resend.com");
    expect(result.options.port).toBe(2465);
    expect(result.options.tls?.mode).toBe("implicit");
  });

  test("brevo+api:// selects the brevo driver", async () => {
    const driver = await run(
      driverFromDsn("brevo+api://xkeysib-key@default", {
        smtp: (options) => ({ name: "smtp", send: () => Effect.void, options }),
        api: (scheme) =>
          scheme === "brevo+api"
            ? { name: "brevo", send: () => Effect.void }
            : { name: "resend", send: () => Effect.void },
      }),
    );
    expect(driver.name).toBe("brevo");
  });
});

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

/** A TLS-from-first-byte relay: it never greets before the TLS handshake completes. */
const startImplicitRelay = async (): Promise<{
  readonly port: number;
  readonly commands: Array<string>;
  readonly authPlainTokens: Array<string>;
  readonly close: () => Promise<void>;
}> => {
  const commands: Array<string> = [];
  const authPlainTokens: Array<string> = [];
  const server = tls.createServer(
    { key: fixture("smtp-test-key.pem"), cert: fixture("smtp-test-cert.pem") },
    (socket) => {
      let inData = false;
      let buffer = "";
      socket.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        if (inData) {
          buffer += text;
          for (;;) {
            const index = buffer.indexOf("\r\n.\r\n");
            if (index < 0) break;
            buffer = buffer.slice(index + 5);
            inData = false;
            socket.write("250 queued\r\n");
          }
          return;
        }
        commands.push(text.trim());
        const upper = text.trim().toUpperCase();
        if (upper.startsWith("EHLO")) {
          socket.write("250-implicit greets you\r\n250 AUTH PLAIN LOGIN\r\n");
        } else if (upper.startsWith("AUTH PLAIN")) {
          authPlainTokens.push(text.trim().slice("AUTH PLAIN ".length));
          socket.write("235 ok\r\n");
        } else if (upper.startsWith("MAIL FROM") || upper.startsWith("RCPT TO")) {
          socket.write("250 ok\r\n");
        } else if (upper === "DATA") {
          inData = true;
          buffer = "";
          socket.write("354 end with <CRLF>.<CRLF>\r\n");
        } else if (upper === "QUIT") {
          socket.write("221 bye\r\n");
          socket.end();
        }
      });
      socket.write("220 implicit.example ESMTP ready\r\n");
      socket.on("error", () => undefined);
    },
  );
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no listen address");
  return {
    port: address.port,
    commands,
    authPlainTokens,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
};

describe("dsn-built driver on the wire: smtps:// is TLS before the SMTP greeting", () => {
  let relay: Awaited<ReturnType<typeof startImplicitRelay>> | undefined;
  afterAll(async () => {
    if (relay !== undefined) await relay.close();
  });

  test("delivers over implicit TLS from the first byte, credentials encrypted", async () => {
    relay = await startImplicitRelay();
    const driver = await run(
      driverFromDsn(`smtps://mailer:hunter2@127.0.0.1:${relay.port}?verify_peer=false`),
    );
    expect(driver.name).toBe("smtp");
    await run(
      driver.send({
        from: { email: "app@example.com" },
        to: [{ email: "ada@example.com" }],
        subject: "implicit dsn",
        text: "over tls",
      }),
    );
    // A TLS-only relay completes the whole transaction: everything it saw —
    // EHLO, encrypted AUTH, envelope, DATA — arrived over the TLS session,
    // i.e. the client spoke TLS before the SMTP greeting.
    expect(relay.commands.some((line) => line.startsWith("EHLO"))).toBe(true);
    expect(relay.authPlainTokens).toHaveLength(1);
    const decoded = Buffer.from(relay.authPlainTokens[0] ?? "", "base64").toString("utf8");
    expect(decoded).toBe("\u0000mailer\u0000hunter2");
    expect(relay.commands).toContain("MAIL FROM:<app@example.com>");
  });
});
