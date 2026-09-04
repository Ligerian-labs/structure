import { describe, expect, test } from "bun:test";
import { Effect, Redacted } from "effect";
import {
  type AuthAuditEvent,
  type AuthEmail,
  allowAllRateLimiter,
  argon2id,
  EmailNotVerified,
  InvalidAuthToken,
  InvalidCredentials,
  inMemoryAuthStore,
  makeAuth,
  RateLimitExceeded,
  type RateLimitRequest,
  type TenantAuthConfig,
} from "../src/index.js";

const tenantConfig: TenantAuthConfig = {
  baseUrl: new URL("https://accounts.example.com"),
  session: { ttlMillis: 60_000, cookieName: "app_session" },
  tokens: {
    emailVerificationTtlMillis: 10_000,
    magicLinkTtlMillis: 10_000,
    passwordResetTtlMillis: 10_000,
  },
  passkey: {
    rpId: "accounts.example.com",
    rpName: "Example",
    origins: ["https://accounts.example.com"],
  },
};

const harness = () => {
  const memory = inMemoryAuthStore();
  const emails: Array<AuthEmail> = [];
  let now = new Date("2026-08-20T12:00:00.000Z");
  const auth = makeAuth({
    store: memory.store,
    resolveTenant: () => Effect.succeed(tenantConfig),
    emailSender: {
      send: (email) => Effect.sync(() => emails.push(email)).pipe(Effect.asVoid),
    },
    rateLimiter: allowAllRateLimiter,
    passwordHasher: argon2id({ memoryCostKiB: 19_456, timeCost: 2 }),
    primitives: { now: () => now },
  });
  return {
    auth,
    emails,
    memory,
    advance: (millis: number) => (now = new Date(now.getTime() + millis)),
  };
};

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const fail = <A, E>(effect: Effect.Effect<A, E>) => run(Effect.flip(effect));

describe("password authentication", () => {
  test("keeps invalid-password failures independent of account existence", async () => {
    const { auth } = harness();
    await run(
      auth.registerPassword({
        tenantId: "tenant-a",
        email: "known@example.com",
        password: "correct horse battery staple",
      }),
    );

    const known = await fail(auth.signInPassword("tenant-a", "known@example.com", ""));
    const unknown = await fail(auth.signInPassword("tenant-a", "unknown@example.com", ""));
    expect(known).toBeInstanceOf(InvalidCredentials);
    expect(unknown).toBeInstanceOf(InvalidCredentials);
  });

  test("requires email verification, consumes its token once, and scopes identities by tenant", async () => {
    const { auth, emails, memory } = harness();

    const first = await run(
      auth.registerPassword({
        tenantId: "tenant-a",
        email: " Ada@Example.com ",
        password: "correct horse battery staple",
        displayName: "Ada",
      }),
    );
    const second = await run(
      auth.registerPassword({
        tenantId: "tenant-b",
        email: "ada@example.com",
        password: "correct horse battery staple",
      }),
    );

    expect(first.email).toBe("ada@example.com");
    expect(second.id).not.toBe(first.id);
    expect(
      await fail(
        auth.signInPassword("tenant-a", first.email ?? "", "correct horse battery staple"),
      ),
    ).toBeInstanceOf(EmailNotVerified);

    const verification = emails.find(
      (email) => email.tenantId === "tenant-a" && email.kind === "email-verification",
    );
    expect(verification).toBeDefined();
    const rawToken = verification === undefined ? "" : Redacted.value(verification.token);
    const verified = await run(auth.verifyEmail("tenant-a", Redacted.make(rawToken)));
    expect(verified.emailVerified).toBe(true);
    expect(await fail(auth.verifyEmail("tenant-a", Redacted.make(rawToken)))).toBeInstanceOf(
      InvalidAuthToken,
    );

    const session = await run(
      auth.signInPassword("tenant-a", "ada@example.com", "correct horse battery staple"),
    );
    const rawSession = Redacted.value(session.token);
    expect(memory.snapshot().sessions[0]?.tokenHash).not.toBe(rawSession);
    expect(JSON.stringify(memory.snapshot())).not.toContain(rawSession);
  });

  test("changes and resets passwords while revoking every older session", async () => {
    const { auth, emails } = harness();
    await run(
      auth.registerPassword({
        tenantId: "tenant-a",
        email: "ada@example.com",
        password: "initial password value",
      }),
    );
    const verify = emails[0];
    if (verify === undefined) throw new Error("verification email was not captured");
    await run(auth.verifyEmail("tenant-a", verify.token));

    const first = await run(
      auth.signInPassword("tenant-a", "ada@example.com", "initial password value"),
    );
    const changed = await run(
      auth.changePassword(
        "tenant-a",
        first.token,
        "initial password value",
        "changed password value",
      ),
    );
    expect(await fail(auth.getSession("tenant-a", first.token))).toBeInstanceOf(InvalidCredentials);
    expect((await run(auth.getSession("tenant-a", changed.token))).user.email).toBe(
      "ada@example.com",
    );

    const countBeforeUnknownReset = emails.length;
    await run(auth.requestPasswordReset("tenant-a", "unknown@example.com"));
    expect(emails).toHaveLength(countBeforeUnknownReset);

    await run(auth.requestPasswordReset("tenant-a", "ada@example.com"));
    const reset = emails.at(-1);
    if (reset === undefined) throw new Error("reset email was not captured");
    const resetSession = await run(
      auth.resetPassword("tenant-a", reset.token, "reset password value"),
    );
    expect(await fail(auth.getSession("tenant-a", changed.token))).toBeInstanceOf(
      InvalidCredentials,
    );
    expect((await run(auth.getSession("tenant-a", resetSession.token))).user.emailVerified).toBe(
      true,
    );
  });
});

describe("magic links and sessions", () => {
  test("creates a verified account, consumes the link once, and emits secure cookies", async () => {
    const { auth, emails, memory } = harness();
    await run(auth.requestMagicLink("tenant-a", "Grace@Example.com"));
    const delivery = emails[0];
    if (delivery === undefined) throw new Error("magic-link email was not captured");

    const session = await run(auth.consumeMagicLink("tenant-a", delivery.token));
    expect(session.user.email).toBe("grace@example.com");
    expect(session.user.emailVerified).toBe(true);
    expect(await fail(auth.consumeMagicLink("tenant-a", delivery.token))).toBeInstanceOf(
      InvalidAuthToken,
    );
    expect(await run(auth.sessionCookie("tenant-a", session))).toContain("app_session=");
    expect(await run(auth.sessionCookie("tenant-a", session))).toContain(
      "; HttpOnly; SameSite=Lax; Secure;",
    );

    await run(auth.signOut("tenant-a", session.token));
    expect(memory.snapshot().sessions).toHaveLength(0);
    expect(await fail(auth.getSession("tenant-a", session.token))).toBeInstanceOf(
      InvalidCredentials,
    );
  });

  test("rejects expired links without creating an account", async () => {
    const { auth, emails, advance, memory } = harness();
    await run(auth.requestMagicLink("tenant-a", "late@example.com"));
    const delivery = emails[0];
    if (delivery === undefined) throw new Error("magic-link email was not captured");
    advance(10_001);

    expect(await fail(auth.consumeMagicLink("tenant-a", delivery.token))).toBeInstanceOf(
      InvalidAuthToken,
    );
    expect(memory.snapshot().users).toHaveLength(0);
  });

  test("passes only hashed limiter keys and secret-free audit events to application ports", async () => {
    const memory = inMemoryAuthStore();
    const emails: Array<AuthEmail> = [];
    const limits: Array<RateLimitRequest> = [];
    const events: Array<AuthAuditEvent> = [];
    const auth = makeAuth({
      store: memory.store,
      resolveTenant: () => Effect.succeed(tenantConfig),
      emailSender: { send: (email) => Effect.sync(() => emails.push(email)).pipe(Effect.asVoid) },
      rateLimiter: {
        check: (request) => Effect.sync(() => limits.push(request)).pipe(Effect.asVoid),
      },
      audit: { record: (event) => Effect.sync(() => events.push(event)).pipe(Effect.asVoid) },
    });

    await run(auth.requestMagicLink("tenant-a", "private@example.com"));
    const delivery = emails[0];
    if (delivery === undefined) throw new Error("magic-link email was not captured");
    await run(auth.consumeMagicLink("tenant-a", delivery.token));

    expect(limits[0]?.keyHash).not.toContain("private@example.com");
    expect(JSON.stringify(events)).not.toContain("private@example.com");
    expect(events.at(-1)).toEqual(
      expect.objectContaining({ action: "magic-link-consume", outcome: "succeeded" }),
    );

    const blocked = makeAuth({
      store: memory.store,
      resolveTenant: () => Effect.succeed(tenantConfig),
      emailSender: { send: () => Effect.void },
      rateLimiter: {
        check: (request) =>
          Effect.fail(new RateLimitExceeded({ action: request.action, retryAfterSeconds: 30 })),
      },
    });
    expect(await fail(blocked.requestMagicLink("tenant-a", "private@example.com"))).toBeInstanceOf(
      RateLimitExceeded,
    );
  });
});

describe("anonymous passkey walls", () => {
  /** Counts checks per key; refuses the 21st within the window. */
  const countingLimiter = () => {
    const counts = new Map<string, number>();
    const limiter = {
      check: (request: RateLimitRequest) =>
        Effect.suspend(() => {
          const key = `${request.action}:${request.keyHash}`;
          const seen = (counts.get(key) ?? 0) + 1;
          counts.set(key, seen);
          return seen > 20
            ? Effect.fail(new RateLimitExceeded({ action: request.action }))
            : Effect.void;
        }),
    };
    return { limiter, counts };
  };

  test("discoverable challenges are walled per caller, never on a shared key", async () => {
    const memory = inMemoryAuthStore();
    const { limiter, counts } = countingLimiter();
    const auth = makeAuth({
      store: memory.store,
      resolveTenant: () => Effect.succeed(tenantConfig),
      emailSender: { send: () => Effect.void },
      rateLimiter: limiter,
    });
    for (let index = 0; index < 20; index++) {
      await run(auth.beginPasskeyAuthentication("tenant-a", undefined, { subject: "203.0.113.7" }));
    }
    expect(
      await fail(
        auth.beginPasskeyAuthentication("tenant-a", undefined, { subject: "203.0.113.7" }),
      ),
    ).toBeInstanceOf(RateLimitExceeded);
    // Another caller is untouched by the first one's budget...
    const other = await run(
      auth.beginPasskeyAuthentication("tenant-a", undefined, { subject: "198.51.100.9" }),
    );
    expect(other.challenge.length).toBeGreaterThan(0);
    // ...and a challenge naming an email is charged on the email, as before.
    await run(
      auth.beginPasskeyAuthentication("tenant-a", "ada@example.com", { subject: "203.0.113.7" }),
    );
    const keys = [...counts.keys()].filter((key) => key.startsWith("passkey-authenticate:"));
    expect(keys).toHaveLength(3);
    expect(keys.some((key) => key.includes("discoverable"))).toBe(false);
    // Nothing in the limiter's keys is a raw subject or email.
    expect(JSON.stringify(keys)).not.toContain("203.0.113.7");
    expect(JSON.stringify(keys)).not.toContain("ada@example.com");
  });

  test("a discoverable challenge without a caller subject charges no shared bucket", async () => {
    const memory = inMemoryAuthStore();
    const { limiter, counts } = countingLimiter();
    const auth = makeAuth({
      store: memory.store,
      resolveTenant: () => Effect.succeed(tenantConfig),
      emailSender: { send: () => Effect.void },
      rateLimiter: limiter,
    });
    for (let index = 0; index < 25; index++) {
      await run(auth.beginPasskeyAuthentication("tenant-a"));
    }
    expect([...counts.keys()].filter((key) => key.startsWith("passkey-authenticate:"))).toEqual([]);
  });
});
