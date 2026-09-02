import { afterAll, describe, expect, test } from "bun:test";
import * as net from "node:net";
import { Effect, Redacted } from "effect";
import {
  MailDeliveryFailed,
  MailRejected,
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
  readonly dataPayloads: Array<string>;
  readonly authPlainTokens: Array<string>;
  readonly close: () => Promise<void>;
  /** Overrides applied before each response. */
  readonly setMailResponse: (line: string) => void;
}

const startFakeSmtp = async (): Promise<FakeSmtpServer> => {
  const commands: Array<string> = [];
  const dataPayloads: Array<string> = [];
  const authPlainTokens: Array<string> = [];
  const sockets = new Set<net.Socket>();
  let mailResponse = "250 ok";
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let inData = false;
    let buffer = "";
    let payloadLines: Array<string> = [];
    socket.write("220 fake ESMTP ready\r\n");
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
        const upper = rawLine.toUpperCase();
        if (upper.startsWith("EHLO")) {
          socket.write("250-fake greets you\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 10485760\r\n");
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
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no listen address");
  return {
    port: address.port,
    commands,
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
});
