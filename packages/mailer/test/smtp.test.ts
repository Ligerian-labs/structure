import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as net from "node:net";
import * as tls from "node:tls";
import { Effect, Redacted, Schema } from "effect";
import {
  EmailHeaders,
  MailDeliveryFailed,
  MailRejected,
  MailValidationError,
  makeSmtpDriver,
  renderSmtpMessage,
  type SmtpOptions,
  stuffDots,
} from "../src/index.js";
import type { EmailMessage } from "../src/message.js";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

interface FakeSmtpServer {
  readonly port: number;
  readonly commands: Array<string>;
  /** Commands received over an encrypted socket (after STARTTLS or on implicit TLS). */
  readonly secureCommands: Array<string>;
  readonly dataPayloads: Array<string>;
  readonly authPlainTokens: Array<string>;
  readonly close: () => Promise<void>;
  /** Overrides applied before each response. */
  readonly setMailResponse: (line: string) => void;
}

interface FakeSmtpOptions {
  /** Advertise STARTTLS in EHLO and upgrade on request. */
  readonly starttls?: boolean;
  /** Listen with TLS from the first byte (port-465 style). */
  readonly implicit?: boolean;
}

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const TEST_CERT = fixture("smtp-test-cert.pem");
const TEST_KEY = fixture("smtp-test-key.pem");

const startFakeSmtp = async (options: FakeSmtpOptions = {}): Promise<FakeSmtpServer> => {
  const commands: Array<string> = [];
  const secureCommands: Array<string> = [];
  const dataPayloads: Array<string> = [];
  const authPlainTokens: Array<string> = [];
  const sockets = new Set<net.Socket>();
  let mailResponse = "250 ok";
  const attach = (socket: net.Socket, secure: boolean): void => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let inData = false;
    let buffer = "";
    let payloadLines: Array<string> = [];
    socket.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (inData) {
        buffer += text;
        for (;;) {
          const index = buffer.indexOf("\r\n");
          if (index < 0) break;
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          if (line === ".") {
            dataPayloads.push(payloadLines.join("\r\n"));
            payloadLines = [];
            inData = false;
            socket.write("250 queued\r\n");
            break;
          }
          payloadLines.push(line);
        }
        return;
      }
      for (const rawLine of text.split("\r\n")) {
        if (rawLine.length === 0) continue;
        commands.push(rawLine);
        if (secure) secureCommands.push(rawLine);
        const upper = rawLine.toUpperCase();
        if (upper.startsWith("EHLO")) {
          const advertise = options.starttls === true && !secure ? "250-STARTTLS\r\n" : "";
          socket.write(
            `250-fake greets you\r\n${advertise}250-AUTH PLAIN LOGIN\r\n250 SIZE 10485760\r\n`,
          );
        } else if (upper === "STARTTLS") {
          socket.write("220 go ahead\r\n");
          socket.removeAllListeners("data");
          const upgraded = new tls.TLSSocket(socket, {
            isServer: true,
            key: TEST_KEY,
            cert: TEST_CERT,
          });
          attach(upgraded, true);
        } else if (upper.startsWith("AUTH PLAIN")) {
          authPlainTokens.push(rawLine.slice("AUTH PLAIN ".length));
          socket.write("235 ok\r\n");
        } else if (upper.startsWith("AUTH LOGIN")) {
          socket.write("334 VXNlcm5hbWU6\r\n");
        } else if (upper.startsWith("MAIL FROM")) {
          socket.write(`${mailResponse}\r\n`);
        } else if (upper.startsWith("RCPT TO")) {
          socket.write("250 ok\r\n");
        } else if (upper === "DATA") {
          inData = true;
          buffer = "";
          payloadLines = [];
          socket.write("354 end data with <CRLF>.<CRLF>\r\n");
        } else if (upper === "QUIT") {
          socket.write("221 bye\r\n");
          socket.end();
        } else if (/^[A-Za-z0-9+/=]+$/u.test(rawLine)) {
          // AUTH LOGIN continuation lines
          socket.write("334 UGFzc3dvcmQ6\r\n");
        }
      }
    });
    if (!secure || options.implicit === true) socket.write("220 fake ESMTP ready\r\n");
  };
  const server =
    options.implicit === true
      ? tls.createServer({ key: TEST_KEY, cert: TEST_CERT }, (socket) => attach(socket, true))
      : net.createServer((socket) => attach(socket, false));
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no listen address");
  return {
    port: address.port,
    commands,
    secureCommands,
    dataPayloads,
    authPlainTokens,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
    setMailResponse: (line) => {
      mailResponse = line;
    },
  };
};

/** Connects every host to the loopback fake, so a non-loopback host name can be tested offline. */
const toLoopback = (_host: string, port: number): net.Socket =>
  net.connect({ host: "127.0.0.1", port });

const fake: FakeSmtpServer = await startFakeSmtp();
afterAll(async () => {
  await fake.close();
});

const options = (extra: Partial<SmtpOptions> = {}): SmtpOptions => ({
  host: "127.0.0.1",
  port: fake.port,
  user: "mailer",
  password: Redacted.make("hunter2"),
  startTls: false,
  ...extra,
});

const message: EmailMessage = {
  from: { email: "app@example.com", name: "App" },
  to: [{ email: "ada@example.com" }],
  cc: [{ email: "grace@example.com" }],
  subject: "Quarterly export",
  text: "here is your export",
  html: "<p>here is your export</p>",
};

describe("smtp driver", () => {
  test("delivers the full transaction: EHLO, AUTH, envelope, DATA, QUIT", async () => {
    await run(makeSmtpDriver(options()).send(message));
    expect(fake.commands.some((line) => line.startsWith("EHLO "))).toBe(true);
    expect(fake.commands).toContain("MAIL FROM:<app@example.com>");
    expect(fake.commands).toContain("RCPT TO:<ada@example.com>");
    expect(fake.commands).toContain("RCPT TO:<grace@example.com>");
    expect(fake.authPlainTokens).toHaveLength(1);
    const decoded = Buffer.from(fake.authPlainTokens[0] ?? "", "base64").toString("utf8");
    expect(decoded).toBe("\u0000mailer\u0000hunter2");
  });

  test("writes MIME headers and a base64 body over the wire", async () => {
    await run(makeSmtpDriver(options()).send(message));
    const payload = fake.dataPayloads[fake.dataPayloads.length - 1] ?? "";
    expect(payload).toContain("Subject: Quarterly export");
    const separator = payload.indexOf("\r\n\r\n");
    expect(separator).toBeGreaterThan(0);
    expect(payload.slice(0, separator)).toContain(
      'Content-Type: multipart/alternative; boundary="',
    );
    expect(payload).toContain("Content-Transfer-Encoding: base64");
    expect(payload).toContain(Buffer.from("here is your export", "utf8").toString("base64"));
    expect(payload).not.toContain("here is your export");
  });

  test("encodes non-ASCII subjects with RFC 2047 encoded-words", async () => {
    await run(makeSmtpDriver(options()).send({ ...message, subject: "Résumé ✓ prêt" }));
    const payload = fake.dataPayloads[fake.dataPayloads.length - 1] ?? "";
    expect(payload).not.toContain("Résumé");
    expect(payload).toMatch(/Subject: =\?UTF-8\?B\?.+\?=/u);
  });

  test("classifies a 5xx envelope rejection as permanent", async () => {
    fake.setMailResponse("550 no relay for you");
    const error = await run(
      Effect.flip(makeSmtpDriver(options()).send({ ...message, subject: "x1" })),
    );
    fake.setMailResponse("250 ok");
    expect(error).toBeInstanceOf(MailRejected);
    if (error instanceof MailRejected) expect(error.reason).toBe("smtp-550");
  });

  test("classifies a 4xx envelope rejection as transient", async () => {
    fake.setMailResponse("450 greylisted, come back later");
    const error = await run(
      Effect.flip(makeSmtpDriver(options()).send({ ...message, subject: "x2" })),
    );
    fake.setMailResponse("250 ok");
    expect(error).toBeInstanceOf(MailDeliveryFailed);
    if (error instanceof MailDeliveryFailed) expect(error.reason).toBe("smtp-450");
  });

  test("classifies unreachable relays as transient transport failures", async () => {
    const error = await run(
      Effect.flip(
        makeSmtpDriver({
          host: "127.0.0.1",
          port: 1,
          connectTimeoutMillis: 1_000,
        }).send({ ...message, subject: "x3" }),
      ),
    );
    expect(error).toBeInstanceOf(MailDeliveryFailed);
    if (error instanceof MailDeliveryFailed) expect(error.reason).toBe("smtp-transport");
  });
});

describe("smtp driver: transport security", () => {
  test("refuses to authenticate over cleartext when a remote relay offers no STARTTLS", async () => {
    const plain = await startFakeSmtp();
    try {
      const error = await run(
        Effect.flip(
          makeSmtpDriver({
            host: "relay.test",
            port: plain.port,
            user: "mailer",
            password: Redacted.make("hunter2"),
            connect: toLoopback,
          }).send({ ...message, subject: "tls-required" }),
        ),
      );
      expect(error).toBeInstanceOf(MailRejected);
      if (error instanceof MailRejected) expect(error.reason).toBe("smtp-tls-required");
      // The relay saw the greeting exchange and nothing that carries a secret or a body.
      expect(plain.commands.some((line) => line.startsWith("EHLO "))).toBe(true);
      expect(plain.commands.some((line) => line.toUpperCase().startsWith("AUTH"))).toBe(false);
      expect(plain.commands.some((line) => line.toUpperCase().startsWith("MAIL FROM"))).toBe(false);
      expect(plain.authPlainTokens).toHaveLength(0);
      expect(plain.dataPayloads).toHaveLength(0);
    } finally {
      await plain.close();
    }
  });

  test("upgrades with STARTTLS and only then authenticates and sends", async () => {
    const relay = await startFakeSmtp({ starttls: true });
    try {
      await run(
        makeSmtpDriver({
          host: "relay.test",
          port: relay.port,
          user: "mailer",
          password: Redacted.make("hunter2"),
          connect: toLoopback,
          tls: { ca: TEST_CERT },
        }).send({ ...message, subject: "starttls" }),
      );
      expect(relay.commands).toContain("STARTTLS");
      const auth = relay.commands.find((line) => line.startsWith("AUTH PLAIN"));
      expect(auth).toBeDefined();
      expect(relay.secureCommands).toContain(auth ?? "");
      expect(relay.secureCommands).toContain("MAIL FROM:<app@example.com>");
      expect(relay.secureCommands).toContain("DATA");
      expect(relay.dataPayloads).toHaveLength(1);
    } finally {
      await relay.close();
    }
  });

  test("a certificate the client does not trust fails the send before any credential is written", async () => {
    const relay = await startFakeSmtp({ starttls: true });
    try {
      const error = await run(
        Effect.flip(
          makeSmtpDriver({
            host: "relay.test",
            port: relay.port,
            user: "mailer",
            password: Redacted.make("hunter2"),
            connect: toLoopback,
          }).send({ ...message, subject: "untrusted" }),
        ),
      );
      expect(error).toBeInstanceOf(MailDeliveryFailed);
      expect(relay.authPlainTokens).toHaveLength(0);
    } finally {
      await relay.close();
    }
  });

  test("implicit TLS (port 465 style) is encrypted from the first byte", async () => {
    const relay = await startFakeSmtp({ implicit: true });
    try {
      await run(
        makeSmtpDriver({
          host: "relay.test",
          port: relay.port,
          user: "mailer",
          password: Redacted.make("hunter2"),
          connect: toLoopback,
          tls: { mode: "implicit", ca: TEST_CERT },
        }).send({ ...message, subject: "implicit" }),
      );
      expect(relay.commands.length).toBeGreaterThan(0);
      expect(relay.secureCommands).toEqual(relay.commands);
      expect(relay.dataPayloads).toHaveLength(1);
    } finally {
      await relay.close();
    }
  });

  test("disabling STARTTLS towards a remote relay is refused at construction unless plaintext is allowed", async () => {
    expect(() => makeSmtpDriver({ host: "relay.test", startTls: false })).toThrow(
      MailValidationError,
    );
    expect(() => makeSmtpDriver({ host: "relay.test", tls: { mode: "none" } })).toThrow(
      MailValidationError,
    );
    const plain = await startFakeSmtp();
    try {
      await run(
        makeSmtpDriver({
          host: "relay.test",
          port: plain.port,
          user: "mailer",
          password: Redacted.make("hunter2"),
          startTls: false,
          allowPlaintext: true,
          connect: toLoopback,
        }).send({ ...message, subject: "opted-in" }),
      );
      expect(plain.authPlainTokens).toHaveLength(1);
    } finally {
      await plain.close();
    }
  });

  test("a loopback relay is exempt: plaintext to localhost needs no opt-in", async () => {
    const plain = await startFakeSmtp();
    try {
      await run(
        makeSmtpDriver({
          host: "localhost",
          port: plain.port,
          user: "mailer",
          password: Redacted.make("hunter2"),
        }).send({ ...message, subject: "loopback" }),
      );
      expect(plain.authPlainTokens).toHaveLength(1);
    } finally {
      await plain.close();
    }
  });
});

describe("smtp message rendering", () => {
  const splitAtBody = (rendered: string): { headerBlock: string; body: string } => {
    const separator = rendered.indexOf("\r\n\r\n");
    expect(separator).toBeGreaterThan(0);
    return { headerBlock: rendered.slice(0, separator), body: rendered.slice(separator + 4) };
  };
  const decodeBase64Body = (body: string): string =>
    Buffer.from(body.replace(/\r\n/gu, ""), "base64").toString("utf8");

  test("text-only messages declare Content-Type in the header block, not the body", () => {
    const { headerBlock, body } = splitAtBody(
      renderSmtpMessage({ ...message, html: undefined }, "structure-mailer"),
    );
    expect(headerBlock).toContain("Content-Type: text/plain; charset=utf-8");
    expect(headerBlock).toContain("Content-Transfer-Encoding: base64");
    expect(body).not.toContain("Content-Type:");
    expect(decodeBase64Body(body)).toBe("here is your export");
  });

  test("html-only messages declare Content-Type in the header block, not the body", () => {
    const { headerBlock, body } = splitAtBody(
      renderSmtpMessage({ ...message, text: undefined }, "structure-mailer"),
    );
    expect(headerBlock).toContain("Content-Type: text/html; charset=utf-8");
    expect(headerBlock).toContain("Content-Transfer-Encoding: base64");
    expect(body).not.toContain("Content-Type:");
    expect(decodeBase64Body(body)).toBe("<p>here is your export</p>");
  });

  test("multipart/alternative declares its boundary in the header block", () => {
    const { headerBlock, body } = splitAtBody(renderSmtpMessage(message, "structure-mailer"));
    const declared = /Content-Type: multipart\/alternative; boundary="([^"]+)"/u.exec(headerBlock);
    expect(declared).not.toBeNull();
    const delimiter = declared?.[1] ?? "";
    expect(body.startsWith(`--${delimiter}\r\n`)).toBe(true);
    expect(body.endsWith(`--${delimiter}--`)).toBe(true);
    expect(body).toContain("Content-Type: text/plain; charset=utf-8");
    expect(body).toContain("Content-Type: text/html; charset=utf-8");
  });

  test("stuffDots doubles leading dots and normalizes line endings", () => {
    expect(stuffDots("a\r\n.b\n.c")).toBe("a\r\n..b\r\n..c");
    expect(stuffDots(".")).toBe("..");
    expect(stuffDots("plain")).toBe("plain");
  });

  test("attachments ride in a multipart/mixed container", () => {
    const rendered = renderSmtpMessage(
      {
        ...message,
        attachments: [
          {
            filename: "report.csv",
            contentType: "text/csv",
            contentBase64: Buffer.from("a,b\n1,2\n", "utf8").toString("base64"),
          },
        ],
      },
      "structure-mailer",
    );
    expect(rendered).toContain('Content-Type: multipart/mixed; boundary="');
    expect(rendered).toContain('Content-Disposition: attachment; filename="report.csv"');
    expect(rendered).not.toContain("a,b\n1,2");
  });

  test("multipart/mixed declares its boundary in the header block", () => {
    const rendered = renderSmtpMessage(
      {
        ...message,
        attachments: [
          {
            filename: "report.csv",
            contentType: "text/csv",
            contentBase64: Buffer.from("a,b\n1,2\n", "utf8").toString("base64"),
          },
        ],
      },
      "structure-mailer",
    );
    const { headerBlock, body } = splitAtBody(rendered);
    const declared = /Content-Type: multipart\/mixed; boundary="([^"]+)"/u.exec(headerBlock);
    expect(declared).not.toBeNull();
    const delimiter = declared?.[1] ?? "";
    expect(body.startsWith(`--${delimiter}\r\n`)).toBe(true);
    expect(body.endsWith(`--${delimiter}--`)).toBe(true);
    expect(body).toContain("Content-Type: multipart/alternative; boundary=");
    expect(body).toContain('Content-Disposition: attachment; filename="report.csv"');
  });

  test("custom headers are appended after the standard set", () => {
    const rendered = renderSmtpMessage(
      { ...message, headers: { "x-tenant": "acme" } },
      "structure-mailer",
    );
    expect(rendered).toContain("x-tenant: acme");
  });

  test("custom headers are emitted exactly once", () => {
    const { headerBlock } = splitAtBody(
      renderSmtpMessage({ ...message, headers: { "X-Thing": "v" } }, "structure-mailer"),
    );
    expect(headerBlock.split("\r\n").filter((line) => line.startsWith("X-Thing:"))).toHaveLength(1);
  });

  test("a custom header can never displace a generated MIME or envelope header", () => {
    const { headerBlock } = splitAtBody(
      renderSmtpMessage(
        {
          ...message,
          html: undefined,
          headers: {
            "Content-Type": "text/html",
            "content-transfer-encoding": "8bit",
            BCC: "spy@example.net",
            "Message-Id": "<forged@example.net>",
          },
        },
        "structure-mailer",
      ),
    );
    const lines = headerBlock.split("\r\n");
    const contentTypes = lines.filter((line) => line.toLowerCase().startsWith("content-type:"));
    expect(contentTypes).toEqual(["Content-Type: text/plain; charset=utf-8"]);
    expect(lines.filter((line) => /^content-transfer-encoding:/iu.test(line))).toEqual([
      "Content-Transfer-Encoding: base64",
    ]);
    expect(lines.some((line) => /^bcc:/iu.test(line))).toBe(false);
    expect(lines.filter((line) => /^message-id:/iu.test(line))).toHaveLength(1);
    expect(headerBlock).not.toContain("forged@example.net");
  });
});

describe("email headers schema", () => {
  test("rejects the generated MIME and envelope header names, case-insensitively", () => {
    for (const name of [
      "Content-Type",
      "content-transfer-encoding",
      "MIME-Version",
      "Bcc",
      "To",
      "Subject",
      "Message-ID",
      "Date",
      "From",
      "Reply-To",
      "cc",
    ]) {
      const decoded = Schema.decodeUnknownEither(EmailHeaders)({ [name]: "x" });
      expect(decoded._tag).toBe("Left");
    }
    expect(Schema.decodeUnknownEither(EmailHeaders)({ "X-Tenant": "acme" })._tag).toBe("Right");
  });
});
