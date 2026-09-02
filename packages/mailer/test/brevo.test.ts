import { describe, expect, test } from "bun:test";
import { Effect, Redacted } from "effect";
import type { EmailDriver } from "../src/driver.js";
import { MailDeliveryFailed, MailRejected, makeBrevoDriver, makeMailer } from "../src/index.js";
import type { EmailMessageInput } from "../src/message.js";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

const message: EmailMessageInput = {
  from: { email: "app@example.com", name: "App" },
  to: [{ email: "ada@example.com" }],
  subject: "hello",
  text: "body",
};

const stubDriver = (
  handler: (request: Request) => Response | Promise<Response>,
): { driver: EmailDriver; requests: Array<Request>; bodies: Array<unknown> } => {
  const requests: Array<Request> = [];
  const bodies: Array<unknown> = [];
  const driver = makeBrevoDriver({
    apiKey: Redacted.make("xkeysib-test-key"),
    baseUrl: "https://brevo.test",
    fetchImpl: (async (input: unknown, init: RequestInit | undefined) => {
      const request = new Request(input as string, init);
      requests.push(request);
      bodies.push(JSON.parse(await request.text()) as unknown);
      return handler(request);
    }) as unknown as typeof fetch,
  });
  return { driver, requests, bodies };
};

describe("brevo driver", () => {
  test("posts the message to /v3/smtp/email with the api-key header and succeeds on 201", async () => {
    const { driver, requests, bodies } = stubDriver(
      () => new Response('{"messageId":"<1@brevo>"}', { status: 201 }),
    );
    await run(driver.send(message));
    expect(driver.name).toBe("brevo");
    expect(requests[0]?.url).toBe("https://brevo.test/v3/smtp/email");
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.headers.get("api-key")).toBe("xkeysib-test-key");
    expect(requests[0]?.headers.get("authorization")).toBeNull();
    expect(requests[0]?.headers.get("content-type")).toBe("application/json");
    const body = bodies[0] as Record<string, unknown>;
    expect(body.sender).toEqual({ email: "app@example.com", name: "App" });
    expect(body.to).toEqual([{ email: "ada@example.com" }]);
    expect(body.subject).toBe("hello");
    expect(body.textContent).toBe("body");
    expect(body).not.toHaveProperty("htmlContent");
    expect(body).not.toHaveProperty("cc");
    expect(body).not.toHaveProperty("bcc");
    expect(body).not.toHaveProperty("replyTo");
    expect(body).not.toHaveProperty("headers");
    expect(body).not.toHaveProperty("attachment");
  });

  test("maps every optional field onto Brevo's body shape", async () => {
    const { driver, bodies } = stubDriver(() => new Response("{}", { status: 202 }));
    await run(
      driver.send({
        ...message,
        cc: [{ email: "cc@example.com", name: "Cc" }],
        bcc: [{ email: "bcc@example.com" }],
        replyTo: { email: "reply@example.com", name: "Reply" },
        html: "<p>body</p>",
        headers: { "X-Campaign": "launch" },
        attachments: [{ filename: "a.txt", contentType: "text/plain", contentBase64: "aGk=" }],
      }),
    );
    const body = bodies[0] as Record<string, unknown>;
    expect(body.cc).toEqual([{ email: "cc@example.com", name: "Cc" }]);
    expect(body.bcc).toEqual([{ email: "bcc@example.com" }]);
    expect(body.replyTo).toEqual({ email: "reply@example.com", name: "Reply" });
    expect(body.htmlContent).toBe("<p>body</p>");
    expect(body.textContent).toBe("body");
    expect(body.headers).toEqual({ "X-Campaign": "launch" });
    expect(body.attachment).toEqual([{ name: "a.txt", content: "aGk=" }]);
  });

  test("maps 4xx to permanent rejection (no retry at the mailer level)", async () => {
    const { driver } = stubDriver(() => new Response("{}", { status: 400 }));
    const error = await run(Effect.flip(driver.send(message)));
    expect(error._tag).toBe("MailRejected");
    expect(error).toBeInstanceOf(MailRejected);
    if (error instanceof MailRejected) {
      expect(error.reason).toBe("brevo-400");
      expect(error.driver).toBe("brevo");
      expect(error.classification).toBe("permanent");
    }
  });

  test("maps 5xx and 429 to transient failures with retry hints", async () => {
    const transient = stubDriver(
      () => new Response("{}", { status: 500, headers: { "retry-after": "7" } }),
    );
    const error = await run(Effect.flip(transient.driver.send(message)));
    expect(error).toBeInstanceOf(MailDeliveryFailed);
    if (error instanceof MailDeliveryFailed) {
      expect(error.reason).toBe("brevo-500");
      expect(error.retryAfterSeconds).toBe(7);
      expect(error.classification).toBe("transient");
    }
    const limited = stubDriver(() => new Response("{}", { status: 429 }));
    const rateError = await run(Effect.flip(limited.driver.send(message)));
    expect(rateError).toBeInstanceOf(MailDeliveryFailed);
    if (rateError instanceof MailDeliveryFailed) expect(rateError.reason).toBe("brevo-429");
  });

  test("maps transport failures to transient", async () => {
    const { driver } = stubDriver(() => {
      throw new Error("network down");
    });
    const error = await run(Effect.flip(driver.send(message)));
    expect(error).toBeInstanceOf(MailDeliveryFailed);
    if (error instanceof MailDeliveryFailed) expect(error.reason).toBe("brevo-network");
  });

  test("never leaks the api key into error reasons or messages", async () => {
    const { driver } = stubDriver(() => new Response("{}", { status: 401 }));
    const error = await run(Effect.flip(driver.send(message)));
    expect(String(error)).not.toContain("xkeysib-test-key");
    expect(error.message).not.toContain("xkeysib-test-key");
  });

  test("keeps the CRLF guards in front of the driver", async () => {
    const { driver, requests } = stubDriver(() => new Response("{}", { status: 201 }));
    const mailer = makeMailer(driver, { retry: { attempts: 1 } });
    const error = await run(
      Effect.flip(mailer.send({ ...message, subject: "hello\r\nBcc: victim@example.com" })),
    );
    expect(error._tag).toBe("MailValidationError");
    expect(requests).toHaveLength(0);
  });
});
