import { describe, expect, test } from "bun:test";
import { Effect, Redacted } from "effect";
import {
  type AuthAuditEvent,
  type AuthEmail,
  AuthValidationError,
  allowAllRateLimiter,
  argon2id,
  InvalidAuthToken,
  InvalidCredentials,
  inMemoryAuthStore,
  makeAuth,
  makeTotp,
  RateLimitExceeded,
  SecondFactorRequired,
  type TenantAuthConfig,
  TOTP_STEP_SECONDS,
  type TotpService,
  totpCode,
} from "../src/index.js";

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

  test("pending sessions cannot mutate passwords, passkeys, or OAuth identities", async () => {
    const { harness, session } = await signedInUser("sensitive@example.com");
    const { enrollment } = await enroll(harness, session.token);
    const pending = await run(
      harness.auth.signInPassword(
        "tenant-a",
        "sensitive@example.com",
        "correct horse battery staple",
      ),
    );
    await run(
      harness.memory.store.addOAuthIdentity({
        tenantId: "tenant-a",
        userId: pending.user.id,
        provider: "github",
        subject: "github-user",
        createdAt: harness.now(),
      }),
    );
    await run(
      harness.memory.store.addPasskey({
        tenantId: "tenant-a",
        userId: pending.user.id,
        credentialId: "credential-1",
        publicKey: "public-key",
        algorithm: "ES256",
        counter: 0,
        transports: [],
        createdAt: harness.now(),
      }),
    );

    expect(
      await fail(harness.auth.beginPasskeyRegistration("tenant-a", pending.token)),
    ).toBeInstanceOf(SecondFactorRequired);
    expect(
      await fail(
        harness.auth.finishPasskeyRegistration("tenant-a", pending.token, {
          credentialId: "not-reached",
          response: { clientDataJSON: "", attestationObject: "" },
        }),
      ),
    ).toBeInstanceOf(SecondFactorRequired);
    expect(
      await fail(
        harness.auth.changePassword(
          "tenant-a",
          pending.token,
          "correct horse battery staple",
          "changed password value",
        ),
      ),
    ).toBeInstanceOf(SecondFactorRequired);
    expect(
      await fail(harness.auth.unlinkOAuthIdentity("tenant-a", pending.token, "github")),
    ).toBeInstanceOf(SecondFactorRequired);
    expect(
      await fail(
        harness.auth.renamePasskey("tenant-a", pending.token, "credential-1", "Security key"),
      ),
    ).toBeInstanceOf(SecondFactorRequired);
    expect(
      await fail(harness.auth.removePasskey("tenant-a", pending.token, "credential-1")),
    ).toBeInstanceOf(SecondFactorRequired);
    expect(harness.memory.snapshot().oauthIdentities).toHaveLength(1);
    expect(harness.memory.snapshot().passkeys).toHaveLength(1);

    await run(
      harness.totp.verify(
        "tenant-a",
        pending.token,
        await run(totpCode(enrollment.secretBase32, harness.now())),
      ),
    );
    await run(harness.auth.beginPasskeyRegistration("tenant-a", pending.token));
    await run(harness.auth.unlinkOAuthIdentity("tenant-a", pending.token, "github"));
    await run(harness.auth.removePasskey("tenant-a", pending.token, "credential-1"));
    expect(harness.memory.snapshot().oauthIdentities).toHaveLength(0);
    expect(harness.memory.snapshot().passkeys).toHaveLength(0);
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
