import * as net from "node:net";
import * as tls from "node:tls";
import { Effect, Redacted } from "effect";
import type { DriverError, EmailDriver } from "../driver.js";
import { MailDeliveryFailed, MailRejected } from "../errors.js";
import type { EmailAddressInput, EmailAttachmentInput, EmailMessage } from "../message.js";

export interface SmtpOptions {
  readonly host: string;
  /** Default 587. */
  readonly port?: number;
  readonly user?: string;
  readonly password?: Redacted.Redacted<string>;
  /** EHLO identifier this client announces. Default `structure-mailer`. */
  readonly hostname?: string;
  /** Upgrade with STARTTLS when the server advertises it. Default true. */
  readonly startTls?: boolean;
  readonly tls?: {
    readonly rejectUnauthorized?: boolean;
    readonly servername?: string;
  };
  /** Default 10s. */
  readonly connectTimeoutMillis?: number;
  /** Default 10s. */
  readonly commandTimeoutMillis?: number;
}

/** A 5yz reply (or unrecoverable misconfiguration): permanent. */
class SmtpRefusal extends Error {
  constructor(readonly reason: string) {
    super(`smtp refused: ${reason}`);
  }
}
/** A 4yz reply: the server temporarily refused — retryable. */
class SmtpRetryable extends Error {
  constructor(readonly code: number) {
    super(`smtp temporarily refused with ${code}`);
  }
}
/** Connection, timeout, TLS, or protocol-shape failures: always retryable. */
class SmtpTransportError extends Error {}

interface Reply {
  readonly code: number;
  readonly lines: ReadonlyArray<string>;
}

interface Waiter {
  readonly resolve: (line: string) => void;
  readonly reject: (error: Error) => void;
}

/** FIFO line queue between the socket's data events and reply readers. */
const makeLineQueue = () => {
  const lines: Array<string> = [];
  const waiters: Array<Waiter> = [];
  let failure: Error | undefined;
  return {
    push: (line: string): void => {
      const waiter = waiters.shift();
      if (waiter === undefined) lines.push(line);
      else waiter.resolve(line);
    },
    read: (): Promise<string> => {
      const line = lines.shift();
      if (line !== undefined) return Promise.resolve(line);
      if (failure !== undefined) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    },
    fail: (error: Error): void => {
      failure = error;
      for (const waiter of waiters.splice(0)) waiter.reject(error);
    },
  };
};

const withTimeout = <A>(promise: Promise<A>, millis: number): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SmtpTransportError("smtp command timeout")), millis);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  }) as Promise<A>;
};

const readReply = async (
  queue: ReturnType<typeof makeLineQueue>,
  timeoutMillis: number,
): Promise<Reply> => {
  const lines: Array<string> = [];
  for (;;) {
    const line = await withTimeout(queue.read(), timeoutMillis);
    const match = /^(\d{3})([ -])(.*)$/u.exec(line);
    if (match === null) throw new SmtpTransportError("malformed smtp reply");
    lines.push(match[3] ?? "");
    if (match[2] === " ") {
      const code = Number(match[1]);
      if (!Number.isInteger(code) || code < 200 || code > 599) {
        throw new SmtpTransportError("nonsense smtp reply code");
      }
      return { code, lines };
    }
  }
};

const assertExpected = (reply: Reply, expected: ReadonlyArray<number>): void => {
  if (expected.includes(reply.code)) return;
  if (reply.code >= 500) throw new SmtpRefusal(`smtp-${reply.code}`);
  if (reply.code >= 400) throw new SmtpRetryable(reply.code);
  throw new SmtpTransportError(`unexpected smtp reply ${reply.code}`);
};

interface Session {
  readonly command: (
    command: string | undefined,
    expected: ReadonlyArray<number>,
  ) => Promise<Reply>;
  readonly readReply: () => Promise<Reply>;
  readonly writeRaw: (data: string) => void;
  readonly close: () => void;
  readonly extensions: ReadonlySet<string>;
  readonly authMechanisms: ReadonlySet<string>;
}

const openSession = (options: SmtpOptions): Promise<Session> =>
  new Promise((resolveOpening, rejectOpening) => {
    const commandTimeout = options.commandTimeoutMillis ?? 10_000;
    const queue = makeLineQueue();
    const hostname = options.hostname ?? "structure-mailer";

    let buffer = "";
    let current: net.Socket | tls.TLSSocket = net.connect({
      host: options.host,
      port: options.port ?? 587,
    });
    current.setNoDelay(true);
    let opened = false;

    const transport = (message: string): SmtpTransportError => new SmtpTransportError(message);

    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const index = buffer.indexOf("\n");
        if (index < 0) break;
        const line = buffer.slice(0, index).replace(/\r$/u, "");
        buffer = buffer.slice(index + 1);
        queue.push(line);
      }
    };

    const fail = (error: Error): void => {
      queue.fail(error);
      if (!opened) {
        opened = true;
        rejectOpening(error);
      }
    };

    current.on("data", onData);
    current.on("error", (error) => fail(transport(`smtp connection: ${error.message}`)));

    const write = (data: string): void => {
      current.write(data);
    };
    const readReplyOnce = (): Promise<Reply> => readReply(queue, commandTimeout);
    const command = async (
      line: string | undefined,
      expected: ReadonlyArray<number>,
    ): Promise<Reply> => {
      if (line !== undefined) write(`${line}\r\n`);
      const reply = await readReplyOnce();
      assertExpected(reply, expected);
      return reply;
    };
    const close = (): void => {
      current.destroy();
    };

    const ehlo = async (): Promise<void> => {
      const reply = await command(`EHLO ${hostname}`, [250]);
      extensions = new Set(
        reply.lines
          .slice(1)
          .map((line) => (line.split(" ")[0] ?? "").toUpperCase())
          .filter((keyword) => keyword.length > 0),
      );
      authMechanisms = new Set(
        reply.lines
          .slice(1)
          .filter((line) => (line.split(" ")[0] ?? "").toUpperCase() === "AUTH")
          .flatMap((line) => line.slice(5).split(/\s+/u))
          .map((mechanism) => mechanism.toUpperCase())
          .filter((mechanism) => mechanism.length > 0),
      );
    };

    let extensions: ReadonlySet<string> = new Set();
    let authMechanisms: ReadonlySet<string> = new Set();

    const upgradeTls = (): Promise<void> =>
      new Promise((resolveTls, rejectTls) => {
        const raw = current;
        raw.removeAllListeners("data");
        const secure = tls.connect({
          socket: raw,
          servername: options.tls?.servername ?? options.host,
          rejectUnauthorized: options.tls?.rejectUnauthorized ?? true,
        });
        secure.once("error", (error) => rejectTls(transport(`smtp tls: ${error.message}`)));
        secure.once("secure", () => {
          current = secure;
          secure.on("data", onData);
          secure.on("error", (error) => fail(transport(`smtp tls: ${error.message}`)));
          resolveTls();
        });
      });

    const start = async (): Promise<void> => {
      try {
        await command(undefined, [220]);
        current.setTimeout(0);
        await ehlo();
        if (
          (options.startTls ?? true) &&
          extensions.has("STARTTLS") &&
          !(current instanceof tls.TLSSocket)
        ) {
          await command("STARTTLS", [220]);
          await upgradeTls();
          await ehlo();
        }
        opened = true;
        resolveOpening({
          command,
          readReply: readReplyOnce,
          writeRaw: write,
          close,
          extensions,
          authMechanisms,
        });
      } catch (error) {
        fail(error instanceof Error ? error : transport("smtp opening failed"));
      }
    };

    current.setTimeout(options.connectTimeoutMillis ?? 10_000, () => {
      current.destroy();
      fail(transport("smtp connect timeout"));
    });

    void start();
  });

const deliver = async (options: SmtpOptions, message: EmailMessage): Promise<void> => {
  const session = await openSession(options);
  try {
    if (options.user !== undefined) {
      const password = Redacted.value(options.password ?? Redacted.make(""));
      if (session.authMechanisms.size === 0) {
        throw new SmtpRefusal("smtp-auth-unsupported");
      }
      if (session.authMechanisms.has("PLAIN")) {
        const token = Buffer.from(`\u0000${options.user}\u0000${password}`, "utf8").toString(
          "base64",
        );
        await session.command(`AUTH PLAIN ${token}`, [235]);
      } else if (session.authMechanisms.has("LOGIN")) {
        await session.command("AUTH LOGIN", [334]);
        await session.command(Buffer.from(options.user, "utf8").toString("base64"), [334]);
        await session.command(Buffer.from(password, "utf8").toString("base64"), [235]);
      } else {
        throw new SmtpRefusal("smtp-auth-mechanism-unsupported");
      }
    }
    await session.command(`MAIL FROM:<${message.from.email}>`, [250]);
    const recipients = [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])];
    for (const recipient of recipients) {
      await session.command(`RCPT TO:<${recipient.email}>`, [250, 251]);
    }
    await session.command("DATA", [354]);
    session.writeRaw(
      `${stuffDots(renderSmtpMessage(message, options.hostname ?? "structure-mailer"))}\r\n.\r\n`,
    );
    const accepted = await session.readReply();
    assertExpected(accepted, [250]);
    await session.command("QUIT", [221]).catch(() => undefined);
  } finally {
    session.close();
  }
};

const ascii = (value: string): boolean => /^[\x20-\x7e]*$/u.test(value);

/** RFC 2047 encoded-word for non-ASCII header text (subjects, display names). */
const encodedWord = (value: string): string =>
  ascii(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;

const headerAddress = (value: EmailAddressInput): string =>
  value.name === undefined ? value.email : `${encodedWord(value.name)} <${value.email}>`;

const wrap76 = (base64: string): string => (base64.match(/.{1,76}/gu) ?? []).join("\r\n");

const CRLF = "\r\n";

const boundary = (): string => {
  let out = "----structure";
  for (let index = 0; index < 24; index++) {
    out += (Math.random() * 36).toString(36)[0];
  }
  return out;
};

/** A MIME entity: the headers that belong in the header block plus the body that follows the blank separator line. */
interface MimeEntity {
  readonly headers: ReadonlyArray<string>;
  readonly body: string;
}

/** Renders an entity as a complete part for nesting inside a multipart container. */
const asPart = (entity: MimeEntity): string => [...entity.headers, "", entity.body].join(CRLF);

/** A base64-encoded text entity: the single-part top level, or one nested part. */
const textEntity = (contentType: "text/plain" | "text/html", body: string): MimeEntity => ({
  headers: [`Content-Type: ${contentType}; charset=utf-8`, "Content-Transfer-Encoding: base64"],
  body: wrap76(Buffer.from(body, "utf8").toString("base64")),
});

/** A multipart container with a fresh random boundary wrapping the given parts. */
const multipartEntity = (
  subtype: "alternative" | "mixed",
  parts: ReadonlyArray<string>,
): MimeEntity => {
  const delimiter = boundary();
  const lines: Array<string> = [];
  for (const part of parts) lines.push(`--${delimiter}`, part);
  lines.push(`--${delimiter}--`);
  return {
    headers: [`Content-Type: multipart/${subtype}; boundary="${delimiter}"`],
    body: lines.join(CRLF),
  };
};

const attachmentPart = (attachment: EmailAttachmentInput): string =>
  [
    `Content-Type: ${attachment.contentType}; name="${attachment.filename}"`,
    `Content-Disposition: attachment; filename="${attachment.filename}"`,
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(attachment.contentBase64),
  ].join(CRLF);

/** Builds the full RFC 5322 message with MIME parts and CRLF line endings. */
export const renderSmtpMessage = (message: EmailMessage, hostname: string): string => {
  const headers: Array<string> = [
    `From: ${headerAddress(message.from)}`,
    `To: ${message.to.map(headerAddress).join(", ")}`,
    ...(message.cc === undefined ? [] : [`Cc: ${message.cc.map(headerAddress).join(", ")}`]),
    ...(message.replyTo === undefined ? [] : [`Reply-To: ${headerAddress(message.replyTo)}`]),
    `Subject: ${encodedWord(message.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${hostname}>`,
    "MIME-Version: 1.0",
  ];
  if (message.headers !== undefined) {
    for (const [name, value] of Object.entries(message.headers)) {
      headers.push(`${name}: ${value}`);
    }
  }

  const content: MimeEntity =
    message.html !== undefined && message.text !== undefined
      ? multipartEntity("alternative", [
          asPart(textEntity("text/plain", message.text)),
          asPart(textEntity("text/html", message.html)),
        ])
      : message.html !== undefined
        ? textEntity("text/html", message.html)
        : textEntity("text/plain", message.text ?? "");

  const attachments = message.attachments ?? [];
  const top: MimeEntity =
    attachments.length === 0
      ? content
      : multipartEntity("mixed", [asPart(content), ...attachments.map(attachmentPart)]);

  headers.push(...top.headers);
  if (message.headers !== undefined) {
    for (const [name, value] of Object.entries(message.headers)) {
      headers.push(`${name}: ${value}`);
    }
  }
  return [...headers, "", top.body].join(CRLF);
};

/** Dot-stuffs and CRLF-normalizes the payload for the DATA phase. */
export const stuffDots = (message: string): string =>
  message
    .replace(/\r?\n/gu, CRLF)
    .split(CRLF)
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join(CRLF);

/**
 * SMTP driver: a minimal RFC 5321 client over `node:net`/`node:tls` — EHLO,
 * opportunistic STARTTLS, AUTH PLAIN/LOGIN, one connection per message.
 * 5yz replies are permanent rejections; 4yz replies, timeouts, and
 * connection/TLS failures are transient (the mailer retries those).
 */
export const makeSmtpDriver = (options: SmtpOptions): EmailDriver => ({
  name: "smtp",
  send: (message) =>
    Effect.tryPromise({
      try: () => deliver(options, message),
      catch: (cause): DriverError =>
        cause instanceof SmtpRefusal
          ? new MailRejected({ driver: "smtp", reason: cause.reason })
          : cause instanceof SmtpRetryable
            ? new MailDeliveryFailed({ driver: "smtp", reason: `smtp-${cause.code}` })
            : new MailDeliveryFailed({ driver: "smtp", reason: "smtp-transport" }),
    }),
});
