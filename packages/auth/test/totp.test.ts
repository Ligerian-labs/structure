import { describe, expect, test } from "bun:test";
import { Effect, Redacted } from "effect";
import {
  type AuthAuditEvent,
  AuthDependencyError,
  type AuthEmail,
  AuthValidationError,
  allowAllRateLimiter,
  argon2id,
  generateTotpSecret,
  InvalidAuthToken,
  InvalidCredentials,
  inMemoryAuthStore,
  makeAuth,
  makeTotp,
  RateLimitExceeded,
  sha256,
  type TenantAuthConfig,
  TOTP_STEP_SECONDS,
  type TotpService,
  totpCode,
} from "../src/index.js";

const INSTANCE_SECRET = Redacted.make("instance-secret-for-tests");

const tenantConfig: TenantAuthConfig = {
  baseUrl: new URL("https://accounts.example.com"),
  session: { ttlMillis: 60 * 60 * 1_000 },
  passkey: {
    rpId: "accounts.example.com",
    rpName: "Example",
    origins: ["https://accounts.example.com"],
  },
};

const build = () => {
  const memory = inMemoryAuthStore();
  const emails: Array<AuthEmail> = [];
  const audit: Array<AuthAuditEvent> = [];
  let now = new Date("2026-08-20T12:00:00.000Z");
  const primitives = { now: () => now };
  let totp: TotpService | undefined;
  const auth = makeAuth({
    store: memory.store,
    resolveTenant: () => Effect.succeed(tenantConfig),
    emailSender: {
      send: (email) => Effect.sync(() => emails.push(email)).pipe(Effect.asVoid),
    },
    rateLimiter: allowAllRateLimiter,
    passwordHasher: argon2id({ memoryCostKiB: 19_456, timeCost: 2 }),
    primitives,
    secondFactor: {
      isEnrolled: (tenantId, userId) =>
        (totp?.isEnrolled(tenantId, userId) ?? Effect.succeed(false)).pipe(
          Effect.catchAll(() => Effect.succeed(false)),
        ),
    },
  });
  totp = makeTotp({
    store: memory.store,
    auth,
    resolveTenant: () => Effect.succeed(tenantConfig),
    rateLimiter: allowAllRateLimiter,
    secret: INSTANCE_SECRET,
    lockoutThreshold: 3,
    lockoutCooldownMillis: 15 * 60 * 1_000,
    primitives,
    audit: { record: (event) => Effect.sync(() => audit.push(event)) },
  });
  return {
    auth,
    totp: totp as TotpService,
    memory,
    emails,
    audit,
    advance: (millis: number) => (now = new Date(now.getTime() + millis)),
    now: () => now,
  };
};

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const fail = <A, E>(effect: Effect.Effect<A, E>) => run(Effect.flip(effect));

/** Registers a verified user and signs in, returning the session token. */
const signedInUser = async (email: string) => {
  const harness = build();
  await run(
    harness.auth.registerPassword({
      tenantId: "tenant-a",
      email,
      password: "correct horse battery staple",
    }),
  );
  const verification = harness.emails.find((mail) => mail.kind === "email-verification");
  expect(verification).toBeDefined();
  await run(harness.auth.verifyEmail("tenant-a", verification?.token ?? Redacted.make("")));
  const session = await run(
    harness.auth.signInPassword("tenant-a", email, "correct horse battery staple"),
  );
  return { harness, session, email };
};

const enroll = async (
  harness: ReturnType<typeof build>,
  sessionToken: Redacted.Redacted<string>,
) => {
  const enrollment = await run(harness.totp.beginEnrollment("tenant-a", sessionToken));
  const confirmation = await run(
    harness.totp.confirmEnrollment(
      "tenant-a",
      sessionToken,
      await run(totpCode(enrollment.secretBase32, harness.now())),
    ),
  );
  // The confirming code is spent (one-time steps): move to the next one, as
  // a person waiting for their authenticator to tick would.
  harness.advance(TOTP_STEP_SECONDS * 1_000);
  return { enrollment, confirmation };
};

describe("totp enrollment", () => {
  test("issues a secret and otpauth URL, confirms with a first valid code", async () => {
    const { harness, session } = await signedInUser("ada@example.com");
    const enrollment = await run(harness.totp.beginEnrollment("tenant-a", session.token));
    expect(enrollment.secretBase32).toMatch(/^[A-Z2-7]{32}$/u);
    expect(enrollment.otpauthUrl).toContain("otpauth://totp/accounts.example.com:");
    expect(enrollment.otpauthUrl).toContain(`secret=${enrollment.secretBase32}`);

    const wrong = await fail(harness.totp.confirmEnrollment("tenant-a", session.token, "000000"));
    expect(wrong).toBeInstanceOf(InvalidCredentials);

    const confirmation = await run(
      harness.totp.confirmEnrollment(
        "tenant-a",
        session.token,
        await run(totpCode(enrollment.secretBase32, harness.now())),
      ),
    );
    expect(confirmation.recoveryCodes).toHaveLength(10);
    for (const code of confirmation.recoveryCodes) {
      expect(Redacted.value(code)).toMatch(/^[a-z2-7]{5}-[a-z2-7]{5}$/u);
    }
    // Second confirmation attempt: already confirmed.
    const again = await fail(harness.totp.confirmEnrollment("tenant-a", session.token, "123456"));
    expect(again).toBeInstanceOf(InvalidAuthToken);
  });

  test("re-enrollment while confirmed is refused", async () => {
    const { harness, session } = await signedInUser("grace@example.com");
    await enroll(harness, session.token);
    const error = await fail(harness.totp.beginEnrollment("tenant-a", session.token));
    expect(error).toBeInstanceOf(AuthValidationError);
  });
});

describe("totp verification and session elevation", () => {
  test("enrolled sessions are born 2fa-pending and elevate on a valid code", async () => {
    const { harness, session } = await signedInUser("ada@example.com");
    const { enrollment } = await enroll(harness, session.token);
    // sign a fresh session in as the enrolled user
    const fresh = await run(
      harness.auth.signInPassword("tenant-a", "ada@example.com", "correct horse battery staple"),
    );
    expect(await run(harness.totp.sessionRequiresElevation("tenant-a", fresh.token))).toBe(true);
    const verified = await run(
      harness.totp.verify(
        "tenant-a",
        fresh.token,
        await run(totpCode(enrollment.secretBase32, harness.now())),
      ),
    );
    expect(verified.elevated).toBe(true);
    expect(await run(harness.totp.sessionRequiresElevation("tenant-a", fresh.token))).toBe(false);
    // The pre-enrollment session never needed elevation either.
    expect(await run(harness.totp.sessionRequiresElevation("tenant-a", session.token))).toBe(false);
  });

  test("a guarded route denies pending sessions and admits elevated ones", async () => {
    const { harness, session } = await signedInUser("ada@example.com");
    const { enrollment } = await enroll(harness, session.token);
    const fresh = await run(
      harness.auth.signInPassword("tenant-a", "ada@example.com", "correct horse battery staple"),
    );
    const guard = (token: Redacted.Redacted<string>): Promise<"allow" | "deny"> =>
      run(
        Effect.map(harness.totp.sessionRequiresElevation("tenant-a", token), (pending) =>
          pending ? ("deny" as const) : ("allow" as const),
        ),
      );
    expect(await guard(fresh.token)).toBe("deny");
    await run(
      harness.totp.verify(
        "tenant-a",
        fresh.token,
        await run(totpCode(enrollment.secretBase32, harness.now())),
      ),
    );
    expect(await guard(fresh.token)).toBe("allow");
  });

  test("codes from the previous step verify; older ones do not", async () => {
    const { harness, session } = await signedInUser("ada@example.com");
    const { enrollment } = await enroll(harness, session.token);
    const fresh = await run(
      harness.auth.signInPassword("tenant-a", "ada@example.com", "correct horse battery staple"),
    );
    // Compute a code, then move two steps forward: outside the ±1 window.
    const agingCode = await run(totpCode(enrollment.secretBase32, harness.now()));
    harness.advance(TOTP_STEP_SECONDS * 2 * 1_000);
    const stale = await fail(harness.totp.verify("tenant-a", fresh.token, agingCode));
    expect(stale).toBeInstanceOf(InvalidCredentials);
    // One step back from now is still inside the window.
    harness.advance(TOTP_STEP_SECONDS * 1_000);
    const previousStepCode = await run(
      totpCode(
        enrollment.secretBase32,
        new Date(harness.now().getTime() - TOTP_STEP_SECONDS * 1_000),
      ),
    );
    const verified = await run(harness.totp.verify("tenant-a", fresh.token, previousStepCode));
    expect(verified.elevated).toBe(true);
  });
});

describe("totp lockout", () => {
  test("locks after the threshold, refuses even valid codes, recovers after cooldown", async () => {
    const { harness, session } = await signedInUser("ada@example.com");
    const { enrollment } = await enroll(harness, session.token);
    const fresh = await run(
      harness.auth.signInPassword("tenant-a", "ada@example.com", "correct horse battery staple"),
    );
    const badCode = async (): Promise<void> => {
      await fail(harness.totp.verify("tenant-a", fresh.token, "000001"));
    };
    await badCode();
    await badCode();
    const locked = await fail(harness.totp.verify("tenant-a", fresh.token, "000001"));
    expect(locked).toBeInstanceOf(RateLimitExceeded);
    const lockEvent = harness.audit.find((event) => event.action === "totp-locked");
    expect(lockEvent).toBeDefined();

    // Even the correct code cannot bypass the lock.
    const correct = await run(totpCode(enrollment.secretBase32, harness.now()));
    const stillLocked = await fail(harness.totp.verify("tenant-a", fresh.token, correct));
    expect(stillLocked).toBeInstanceOf(RateLimitExceeded);

    // After the cooldown the same session verifies normally.
    harness.advance(15 * 60 * 1_000 + 1_000);
    const afterCooldown = await run(
      harness.totp.verify(
        "tenant-a",
        fresh.token,
        await run(totpCode(enrollment.secretBase32, harness.now())),
      ),
    );
    expect(afterCooldown.elevated).toBe(true);
  });
});

describe("recovery codes", () => {
  test("are single-use and elevate the session", async () => {
    const { harness, session } = await signedInUser("ada@example.com");
    const { confirmation } = await enroll(harness, session.token);
    const fresh = await run(
      harness.auth.signInPassword("tenant-a", "ada@example.com", "correct horse battery staple"),
    );
    const code = Redacted.value(confirmation.recoveryCodes[0] ?? Redacted.make(""));
    const first = await run(harness.totp.verify("tenant-a", fresh.token, code));
    expect(first.elevated).toBe(true);
    // A second session: the same recovery code is spent.
    const another = await run(
      harness.auth.signInPassword("tenant-a", "ada@example.com", "correct horse battery staple"),
    );
    const error = await fail(harness.totp.verify("tenant-a", another.token, code));
    expect(error).toBeInstanceOf(InvalidCredentials);
  });
});

describe("unenrollment", () => {
  test("requires a valid code and removes the enrollment", async () => {
    const { harness, session } = await signedInUser("ada@example.com");
    const { enrollment } = await enroll(harness, session.token);
    const fresh = await run(
      harness.auth.signInPassword("tenant-a", "ada@example.com", "correct horse battery staple"),
    );
    const denied = await fail(harness.totp.unenroll("tenant-a", fresh.token, "000002"));
    expect(denied).toBeInstanceOf(InvalidCredentials);
    await run(
      harness.totp.unenroll(
        "tenant-a",
        fresh.token,
        await run(totpCode(enrollment.secretBase32, harness.now())),
      ),
    );
    // New sessions need no elevation anymore.
    const plain = await run(
      harness.auth.signInPassword("tenant-a", "ada@example.com", "correct horse battery staple"),
    );
    expect(await run(harness.totp.sessionRequiresElevation("tenant-a", plain.token))).toBe(false);
    const unenrollEvent = harness.audit.find((event) => event.action === "totp-unenroll");
    expect(unenrollEvent).toBeDefined();
  });
});

describe("one-time codes", () => {
  test("a code that already elevated a session is refused everywhere until the next step", async () => {
    const { harness, session } = await signedInUser("ada@example.com");
    const { enrollment } = await enroll(harness, session.token);
    // The confirming code itself (one step back now) is spent: it cannot elevate a session.
    const confirmingCode = await run(
      totpCode(
        enrollment.secretBase32,
        new Date(harness.now().getTime() - TOTP_STEP_SECONDS * 1_000),
      ),
    );
    const pendingAfterConfirm = await run(
      harness.auth.signInPassword("tenant-a", "ada@example.com", "correct horse battery staple"),
    );
    expect(
      await fail(harness.totp.verify("tenant-a", pendingAfterConfirm.token, confirmingCode)),
    ).toBeInstanceOf(InvalidCredentials);

    const first = await run(
      harness.auth.signInPassword("tenant-a", "ada@example.com", "correct horse battery staple"),
    );
    const second = await run(
      harness.auth.signInPassword("tenant-a", "ada@example.com", "correct horse battery staple"),
    );
    const code = await run(totpCode(enrollment.secretBase32, harness.now()));
    expect((await run(harness.totp.verify("tenant-a", first.token, code))).elevated).toBe(true);
    // The same code, seen once, is worth exactly one login.
    expect(await fail(harness.totp.verify("tenant-a", second.token, code))).toBeInstanceOf(
      InvalidCredentials,
    );
    expect(await fail(harness.totp.unenroll("tenant-a", first.token, code))).toBeInstanceOf(
      InvalidCredentials,
    );
    expect(await run(harness.totp.sessionRequiresElevation("tenant-a", second.token))).toBe(true);
    // The next step's code is fresh again.
    harness.advance(TOTP_STEP_SECONDS * 1_000);
    const next = await run(totpCode(enrollment.secretBase32, harness.now()));
    expect((await run(harness.totp.verify("tenant-a", second.token, next))).elevated).toBe(true);
  });
});

describe("lost authenticator", () => {
  test("a recovery code unenrolls, is spent by it, and the operator can reset the factor", async () => {
    const { harness, session } = await signedInUser("ada@example.com");
    const { confirmation } = await enroll(harness, session.token);
    const codes = confirmation.recoveryCodes.map((code) => Redacted.value(code));
    const pending = await run(
      harness.auth.signInPassword("tenant-a", "ada@example.com", "correct horse battery staple"),
    );
    expect(
      (await run(harness.totp.verify("tenant-a", pending.token, codes[0] ?? ""))).elevated,
    ).toBe(true);
    // The code that signed Ada in is spent for unenrollment too...
    expect(
      await fail(harness.totp.unenroll("tenant-a", pending.token, codes[0] ?? "")),
    ).toBeInstanceOf(InvalidCredentials);
    // ...and a fresh recovery code turns the factor off, exactly like a TOTP code would.
    await run(harness.totp.unenroll("tenant-a", pending.token, codes[1] ?? ""));
    expect(await run(harness.totp.isEnrolled("tenant-a", pending.user.id))).toBe(false);
    const plain = await run(
      harness.auth.signInPassword("tenant-a", "ada@example.com", "correct horse battery staple"),
    );
    expect(await run(harness.totp.sessionRequiresElevation("tenant-a", plain.token))).toBe(false);
    expect(harness.audit.some((event) => event.action === "totp-unenroll")).toBe(true);

    // Re-enrolled, then the phone is gone and the recovery codes with it:
    // the operator's reset removes the factor and leaves an audited trace.
    await enroll(harness, plain.token);
    expect(await run(harness.totp.isEnrolled("tenant-a", plain.user.id))).toBe(true);
    const locked = await run(
      harness.auth.signInPassword("tenant-a", "ada@example.com", "correct horse battery staple"),
    );
    expect(await run(harness.totp.sessionRequiresElevation("tenant-a", locked.token))).toBe(true);
    await run(
      harness.totp.resetSecondFactor("tenant-a", plain.user.id, { actor: "ops@example.com" }),
    );
    expect(await run(harness.totp.isEnrolled("tenant-a", plain.user.id))).toBe(false);
    expect(await run(harness.totp.sessionRequiresElevation("tenant-a", locked.token))).toBe(false);
    expect(harness.audit.at(-1)).toEqual(
      expect.objectContaining({
        action: "totp-reset",
        outcome: "succeeded",
        userId: plain.user.id,
        actor: "ops@example.com",
      }),
    );
    // Resetting a user without a factor is a no-op that still audits nothing new.
    const before = harness.audit.length;
    await run(
      harness.totp.resetSecondFactor("tenant-a", plain.user.id, { actor: "ops@example.com" }),
    );
    expect(harness.audit.length).toBe(before);
  });
});

describe("second factor at rest", () => {
  test("stores the secret sealed and the recovery codes salted under the instance secret", async () => {
    const { harness, session } = await signedInUser("ada@example.com");
    const { enrollment, confirmation } = await enroll(harness, session.token);
    const record = harness.memory.snapshot().totp[0];
    expect(record?.secretBase32).not.toBe(enrollment.secretBase32);
    expect(record?.secretBase32.startsWith("v1:")).toBe(true);
    const codes = confirmation.recoveryCodes.map((code) => Redacted.value(code));
    const plainHashes = await Promise.all(codes.map((code) => run(sha256(code))));
    for (const stored of record?.recoveryCodeHashes ?? []) {
      expect(stored.startsWith("v1:")).toBe(true);
      expect(plainHashes).not.toContain(stored);
    }
    // One salt per code: two enrollments of the same code never share a hash.
    const salts = new Set((record?.recoveryCodeHashes ?? []).map((stored) => stored.split(":")[1]));
    expect(salts.size).toBe(codes.length);

    // The same store read under another instance secret yields no second factor.
    const foreign = makeTotp({
      store: harness.memory.store,
      auth: harness.auth,
      resolveTenant: () => Effect.succeed(tenantConfig),
      rateLimiter: allowAllRateLimiter,
      secret: Redacted.make("another-instance"),
      primitives: { now: harness.now },
    });
    const pending = await run(
      harness.auth.signInPassword("tenant-a", "ada@example.com", "correct horse battery staple"),
    );
    const code = await run(totpCode(enrollment.secretBase32, harness.now()));
    expect(await fail(foreign.verify("tenant-a", pending.token, code))).toBeInstanceOf(
      AuthDependencyError,
    );
    expect(await run(harness.totp.sessionRequiresElevation("tenant-a", pending.token))).toBe(true);
    // The owning instance still verifies both kinds of code.
    expect((await run(harness.totp.verify("tenant-a", pending.token, code))).elevated).toBe(true);
    const another = await run(
      harness.auth.signInPassword("tenant-a", "ada@example.com", "correct horse battery staple"),
    );
    expect(
      (await run(harness.totp.verify("tenant-a", another.token, codes[3] ?? ""))).elevated,
    ).toBe(true);
    expect(harness.memory.snapshot().totp[0]?.recoveryCodeHashes).toHaveLength(codes.length - 1);
  });

  test("a record from before sealing keeps verifying and is sealed on its first success", async () => {
    const { harness, session } = await signedInUser("ada@example.com");
    const secret = generateTotpSecret();
    const legacyHash = await run(sha256("abcde-fghij"));
    await run(
      harness.memory.store.putTotpSecret({
        tenantId: "tenant-a",
        userId: session.user.id,
        secretBase32: secret,
        confirmed: true,
        recoveryCodeHashes: [legacyHash],
        failedAttempts: 0,
        enrolledAt: harness.now(),
      }),
    );
    const pending = await run(
      harness.auth.signInPassword("tenant-a", "ada@example.com", "correct horse battery staple"),
    );
    expect(await run(harness.totp.sessionRequiresElevation("tenant-a", pending.token))).toBe(true);
    const code = await run(totpCode(secret, harness.now()));
    expect((await run(harness.totp.verify("tenant-a", pending.token, code))).elevated).toBe(true);
    const sealed = harness.memory.snapshot().totp[0];
    expect(sealed?.secretBase32).not.toBe(secret);
    expect(sealed?.secretBase32.startsWith("v1:")).toBe(true);
    expect(sealed?.recoveryCodeHashes).toEqual([legacyHash]);
    // The legacy recovery code still works once...
    const another = await run(
      harness.auth.signInPassword("tenant-a", "ada@example.com", "correct horse battery staple"),
    );
    expect(
      (await run(harness.totp.verify("tenant-a", another.token, "abcde-fghij"))).elevated,
    ).toBe(true);
    expect(harness.memory.snapshot().totp[0]?.recoveryCodeHashes).toEqual([]);
    // ...and the sealed secret verifies the next step.
    harness.advance(TOTP_STEP_SECONDS * 1_000);
    const third = await run(
      harness.auth.signInPassword("tenant-a", "ada@example.com", "correct horse battery staple"),
    );
    const next = await run(totpCode(secret, harness.now()));
    expect((await run(harness.totp.verify("tenant-a", third.token, next))).elevated).toBe(true);
  });
});
