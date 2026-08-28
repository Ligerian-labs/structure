import {
  type AuthEmail,
  type AuthHandler,
  type AuthService,
  allowAllRateLimiter,
  inMemoryAuthStore,
  makeAuth,
  makeAuthHandler,
  type TenantAuthConfig,
} from "@structure-ai/auth";
import { Effect, Redacted } from "effect";

/** An auth e-mail captured by {@link TestAuth.make}'s recording sender. */
export interface RecordedAuthEmail {
  readonly to: string;
  readonly kind: string;
  /** The one-time token, unwrapped — fixture steps feed it back into `verifyEmail`. */
  readonly token: string;
  readonly url: string;
  readonly tenantId: string;
}

/** The test auth stack: the real auth service over in-memory doubles. */
export interface TestAuth {
  readonly tenantId: string;
  readonly auth: AuthService;
  readonly authHandler: AuthHandler;
  /** Every e-mail the service sent, in order — tokens included. */
  readonly emails: ReadonlyArray<RecordedAuthEmail>;
}

/**
 * The in-memory auth composition every feature suite rebuilds by hand: the
 * real `makeAuth` service over an in-memory store with an allow-all rate
 * limiter and a recording e-mail sender (verification tokens stay accessible
 * to steps). One per scenario world.
 *
 * ```ts
 * const testAuth = TestAuth.make({ tenantId: "ps", baseUrl: new URL("http://localhost:3000") });
 * // ... expose on the world, or as Layer.succeed(AppAuthTag, { auth: testAuth.auth, ... })
 * ```
 */
export const TestAuth = {
  make: (options: {
    readonly tenantId: string;
    readonly baseUrl: URL;
    readonly tenant?: Partial<TenantAuthConfig>;
  }): TestAuth => {
    const emails: Array<RecordedAuthEmail> = [];
    const tenant: TenantAuthConfig = { baseUrl: options.baseUrl, ...options.tenant };
    const auth = makeAuth({
      store: inMemoryAuthStore().store,
      resolveTenant: () => Effect.succeed(tenant),
      emailSender: {
        send: (email: AuthEmail) =>
          Effect.sync(() => {
            emails.push({
              to: email.to,
              kind: email.kind,
              token: Redacted.value(email.token),
              url: email.url,
              tenantId: email.tenantId,
            });
          }),
      },
      rateLimiter: allowAllRateLimiter,
    });
    const authHandler = makeAuthHandler(auth, {
      resolveTenant: () => Effect.succeed(options.tenantId),
    });
    return { tenantId: options.tenantId, auth, authHandler, emails };
  },
};

/**
 * Registers a customer the way the client app does: password registration →
 * capture the verification e-mail the recording sender observed → verify →
 * returns the fresh user id. Fixture-infra failures (rejected registration,
 * no verification e-mail) die with context — they are test bugs, not
 * business outcomes the scenario asserts.
 */
export const registerVerifiedCustomer = (options: {
  readonly testAuth: TestAuth;
  readonly email: string;
  readonly password: string;
  readonly displayName?: string;
}): Effect.Effect<string, Error> =>
  Effect.gen(function* () {
    const { testAuth } = options;
    const registered = yield* testAuth.auth
      .registerPassword({
        tenantId: testAuth.tenantId,
        email: options.email,
        password: options.password,
        displayName: options.displayName ?? options.email.split("@")[0] ?? options.email,
      })
      .pipe(Effect.mapError((error) => new Error(`registration failed: ${String(error)}`)));
    const verification = testAuth.emails.find(
      (email) => email.kind === "email-verification" && email.to === options.email,
    );
    if (verification === undefined) {
      return yield* Effect.die(`no verification email captured for ${options.email}`);
    }
    yield* testAuth.auth
      .verifyEmail(testAuth.tenantId, Redacted.make(verification.token))
      .pipe(Effect.mapError((error) => new Error(`verification failed: ${String(error)}`)));
    return registered.id;
  });

/**
 * Signs in with a password and returns the raw session token (unwrapped) —
 * steps record it on the world for later authenticated calls. Fails (does
 * not die) with a descriptive error: a `Given` signing in a known customer
 * is fixture, but a `When` exercising wrong-password flows asserts on the
 * outcome.
 */
export const signInPassword = (options: {
  readonly testAuth: TestAuth;
  readonly email: string;
  readonly password: string;
}): Effect.Effect<string, Error> =>
  Effect.gen(function* () {
    const session = yield* options.testAuth.auth
      .signInPassword(options.testAuth.tenantId, options.email, options.password)
      .pipe(Effect.mapError((error) => new Error(`sign-in failed: ${String(error)}`)));
    return Redacted.value(session.token);
  });
