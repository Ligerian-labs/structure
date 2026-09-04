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
  sha256,
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

describe("password sign-in wall", () => {
  test("keys on email and caller, peeks before verifying and charges failures only", async () => {
    const counts = new Map<string, number>();
    const memory = inMemoryAuthStore();
    const emails: Array<AuthEmail> = [];
    const keyOf = (request: RateLimitRequest) => `${request.action}:${request.keyHash}`;
    const auth = makeAuth({
      store: memory.store,
      resolveTenant: () => Effect.succeed(tenantConfig),
      emailSender: { send: (email) => Effect.sync(() => emails.push(email)).pipe(Effect.asVoid) },
      passwordHasher: argon2id({ memoryCostKiB: 19_456, timeCost: 2 }),
      rateLimiter: {
        peek: (request) =>
          (counts.get(keyOf(request)) ?? 0) >= 5
            ? Effect.fail(new RateLimitExceeded({ action: request.action }))
            : Effect.void,
        check: (request) =>
          Effect.suspend(() => {
            const seen = (counts.get(keyOf(request)) ?? 0) + 1;
            counts.set(keyOf(request), seen);
            return seen > 5
              ? Effect.fail(new RateLimitExceeded({ action: request.action }))
              : Effect.void;
          }),
      },
    });
    await run(
      auth.registerPassword({
        tenantId: "tenant-a",
        email: "ada@example.com",
        password: "correct horse battery staple",
      }),
    );
    const verification = emails.find((mail) => mail.kind === "email-verification");
    await run(auth.verifyEmail("tenant-a", verification?.token ?? Redacted.make("")));
    counts.clear();

    const attacker = { subject: "203.0.113.7" };
    for (let index = 0; index < 5; index++) {
      expect(
        await fail(auth.signInPassword("tenant-a", "ada@example.com", "wrong", attacker)),
      ).toBeInstanceOf(InvalidCredentials);
    }
    // The attacker's bucket is exhausted: even the right password is refused there...
    expect(
      await fail(
        auth.signInPassword(
          "tenant-a",
          "ada@example.com",
          "correct horse battery staple",
          attacker,
        ),
      ),
    ).toBeInstanceOf(RateLimitExceeded);
    // ...while Ada, from her own address, still signs in.
    const session = await run(
      auth.signInPassword("tenant-a", "ada@example.com", "correct horse battery staple", {
        subject: "198.51.100.9",
      }),
    );
    expect(session.user.email).toBe("ada@example.com");
    // Only failures were charged: the email+caller bucket and the caller's own
    // bucket, five charges each, nothing for the success.
    const signInKeys = [...counts.entries()].filter(([key]) => key.startsWith("password-sign-in:"));
    expect(signInKeys).toHaveLength(2);
    expect(signInKeys.every(([, count]) => count === 5)).toBe(true);
    expect(JSON.stringify(signInKeys)).not.toContain("ada@example.com");
    expect(JSON.stringify(signInKeys)).not.toContain("203.0.113.7");
  });

  test("keeps consume-on-arrival for a limiter that cannot peek", async () => {
    const limits: Array<RateLimitRequest> = [];
    const memory = inMemoryAuthStore();
    const auth = makeAuth({
      store: memory.store,
      resolveTenant: () => Effect.succeed(tenantConfig),
      emailSender: { send: () => Effect.void },
      passwordHasher: argon2id({ memoryCostKiB: 19_456, timeCost: 2 }),
      rateLimiter: {
        check: (request) => Effect.sync(() => limits.push(request)).pipe(Effect.asVoid),
      },
    });
    await fail(auth.signInPassword("tenant-a", "nobody@example.com", "wrong"));
    expect(limits.filter((entry) => entry.action === "password-sign-in")).toHaveLength(1);
  });
});

describe("password sign-in wall: rejected sign-ins are charged", () => {
  /** A limiter that can peek: `check` charges, `peek` only refuses an exhausted bucket. */
  const peekingLimiter = (cap: number) => {
    const counts = new Map<string, number>();
    const keyOf = (request: RateLimitRequest) => `${request.action}:${request.keyHash}`;
    return {
      counts,
      limiter: {
        peek: (request: RateLimitRequest) =>
          (counts.get(keyOf(request)) ?? 0) >= cap
            ? Effect.fail(new RateLimitExceeded({ action: request.action }))
            : Effect.void,
        check: (request: RateLimitRequest) =>
          Effect.suspend(() => {
            const seen = (counts.get(keyOf(request)) ?? 0) + 1;
            counts.set(keyOf(request), seen);
            return seen > cap
              ? Effect.fail(new RateLimitExceeded({ action: request.action }))
              : Effect.void;
          }),
      },
    };
  };

  test("an unverified account's sign-in is charged like any other rejection", async () => {
    const memory = inMemoryAuthStore();
    const { limiter, counts } = peekingLimiter(5);
    const auth = makeAuth({
      store: memory.store,
      resolveTenant: () => Effect.succeed(tenantConfig),
      emailSender: { send: () => Effect.void },
      passwordHasher: argon2id({ memoryCostKiB: 19_456, timeCost: 2 }),
      rateLimiter: limiter,
    });
    await run(
      auth.registerPassword({
        tenantId: "tenant-a",
        email: "new@example.com",
        password: "correct horse battery staple",
      }),
    );
    counts.clear();
    const caller = { subject: "203.0.113.7" };
    for (let index = 0; index < 5; index++) {
      expect(
        await fail(
          auth.signInPassword(
            "tenant-a",
            "new@example.com",
            "correct horse battery staple",
            caller,
          ),
        ),
      ).toBeInstanceOf(EmailNotVerified);
    }
    // The sixth attempt is refused by the wall, before any password work.
    expect(
      await fail(
        auth.signInPassword("tenant-a", "new@example.com", "correct horse battery staple", caller),
      ),
    ).toBeInstanceOf(RateLimitExceeded);
    const charged = [...counts.values()];
    expect(charged.length).toBeGreaterThan(0);
    expect(charged.every((count) => count === 5)).toBe(true);
  });
});

describe("password sign-in wall: a ceiling per caller", () => {
  test("spraying many emails from one caller exhausts that caller's own budget", async () => {
    const counts = new Map<string, number>();
    const keyOf = (request: RateLimitRequest) => `${request.action}:${request.keyHash}`;
    const memory = inMemoryAuthStore();
    const emails: Array<AuthEmail> = [];
    const auth = makeAuth({
      store: memory.store,
      resolveTenant: () => Effect.succeed(tenantConfig),
      emailSender: { send: (email) => Effect.sync(() => emails.push(email)).pipe(Effect.asVoid) },
      passwordHasher: argon2id({ memoryCostKiB: 19_456, timeCost: 2 }),
      // A limiter whose `check` only meters: the refusal can come from a
      // genuine peek of the caller's bucket and from nothing else.
      rateLimiter: {
        peek: (request) =>
          (counts.get(keyOf(request)) ?? 0) >= 5
            ? Effect.fail(new RateLimitExceeded({ action: request.action }))
            : Effect.void,
        check: (request) =>
          Effect.sync(() => {
            counts.set(keyOf(request), (counts.get(keyOf(request)) ?? 0) + 1);
          }),
      },
    });
    await run(
      auth.registerPassword({
        tenantId: "tenant-a",
        email: "ada@example.com",
        password: "correct horse battery staple",
      }),
    );
    const verification = emails.find((mail) => mail.kind === "email-verification");
    await run(auth.verifyEmail("tenant-a", verification?.token ?? Redacted.make("")));
    counts.clear();

    const sprayer = { subject: "203.0.113.7" };
    const outcomes: Array<string> = [];
    for (let index = 0; index < 20; index++) {
      const error = await fail(
        auth.signInPassword("tenant-a", `victim-${index}@example.com`, "guess", sprayer),
      );
      outcomes.push(error._tag);
    }
    // Five distinct emails cost five failures; the sixth email is refused by the caller's ceiling.
    expect(outcomes.slice(0, 5).every((tag) => tag === "InvalidCredentials")).toBe(true);
    expect(outcomes.slice(5).every((tag) => tag === "RateLimitExceeded")).toBe(true);
    // Ada, from her own address, is untouched by the sprayer's budget.
    const session = await run(
      auth.signInPassword("tenant-a", "ada@example.com", "correct horse battery staple", {
        subject: "198.51.100.9",
      }),
    );
    expect(session.user.email).toBe("ada@example.com");
  });
});

describe("passkey verification wall", () => {
  test("keys on the caller when one is given, else on the credential id", async () => {
    const limits: Array<RateLimitRequest> = [];
    const memory = inMemoryAuthStore();
    const auth = makeAuth({
      store: memory.store,
      resolveTenant: () => Effect.succeed(tenantConfig),
      emailSender: { send: () => Effect.void },
      rateLimiter: { check: (request) => Effect.sync(() => void limits.push(request)) },
    });
    const response = {
      credentialId: "credential-1",
      response: { clientDataJSON: "", authenticatorData: "", signature: "" },
    };
    // The verification itself fails (no challenge behind this response);
    // only the wall's key is under test here.
    await fail(auth.finishPasskeyAuthentication("tenant-a", response, { subject: "203.0.113.7" }));
    await fail(auth.finishPasskeyAuthentication("tenant-a", response, { subject: "198.51.100.9" }));
    await fail(auth.finishPasskeyAuthentication("tenant-a", response));
    const keys = limits
      .filter((entry) => entry.action === "passkey-authenticate")
      .map((entry) => entry.keyHash);
    expect(keys).toHaveLength(3);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[2]).toBe(await run(sha256("credential-1")));
    expect(keys[0]).toBe(await run(sha256("203.0.113.7")));
  });
});
