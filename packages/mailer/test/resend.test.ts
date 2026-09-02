import { describe, expect, test } from "bun:test";
import { Effect, Redacted } from "effect";
import type { EmailDriver } from "../src/driver.js";
import { MailDeliveryFailed, MailRejected, makeResendDriver } from "../src/index.js";
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
  const driver = makeResendDriver({
    apiKey: Redacted.make("re_test_key"),
    baseUrl: "https://resend.test",
    fetchImpl: (async (input: unknown, init: RequestInit | undefined) => {
      const request = new Request(input as string, init);
      requests.push(request);
      bodies.push(JSON.parse(await request.text()) as unknown);
      return handler(request);
    }) as unknown as typeof fetch,
  });
  return { driver, requests, bodies };
};

describe("resend driver", () => {
  test("posts the message and succeeds on 200", async () => {
    const { driver, requests, bodies } = stubDriver(() => new Response("{}", { status: 200 }));
    await run(driver.send(message));
    expect(requests[0]?.url).toBe("https://resend.test/emails");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer re_test_key");
    const body = bodies[0] as Record<string, unknown>;
    expect(body.from).toBe("App <app@example.com>");
    expect(body.to).toEqual(["ada@example.com"]);
    expect(body.subject).toBe("hello");
  });

  test("maps 4xx to permanent rejection (no retry at the mailer level)", async () => {
    const { driver } = stubDriver(() => new Response("{}", { status: 422 }));
    const error = await run(Effect.flip(driver.send(message)));
    expect(error._tag).toBe("MailRejected");
    expect(error).toBeInstanceOf(MailRejected);
    if (error instanceof MailRejected) expect(error.reason).toBe("resend-422");
  });

  test("maps 5xx and 429 to transient failures with retry hints", async () => {
    const transient = stubDriver(
      () => new Response("{}", { status: 500, headers: { "retry-after": "7" } }),
    );
    const error = await run(Effect.flip(transient.driver.send(message)));
    expect(error).toBeInstanceOf(MailDeliveryFailed);
    if (error instanceof MailDeliveryFailed) {
      expect(error.reason).toBe("resend-500");
      expect(error.retryAfterSeconds).toBe(7);
    }
    const limited = stubDriver(() => new Response("{}", { status: 429 }));
    const rateError = await run(Effect.flip(limited.driver.send(message)));
    expect(rateError).toBeInstanceOf(MailDeliveryFailed);
  });

  test("maps transport failures to transient", async () => {
    const { driver } = stubDriver(() => {
      throw new Error("network down");
    });
    const error = await run(Effect.flip(driver.send(message)));
    expect(error).toBeInstanceOf(MailDeliveryFailed);
    if (error instanceof MailDeliveryFailed) expect(error.reason).toBe("resend-network");
  });
});
