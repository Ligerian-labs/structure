import type { AuthEmail, AuthService, TenantAuthConfig } from "@structure-ai/auth";
import { allowAllRateLimiter, inMemoryAuthStore, makeAuth } from "@structure-ai/auth";
import { Effect, Redacted } from "effect";

/**
 * An auth e-mail captured by {@link RecordingAuth.make}'s recording sender.
 * Same shape as `@structure-ai/bdd`'s `TestAuth` recordings.
 */
export interface RecordedAuthEmail {
  readonly to: string;
  readonly kind: string;
  /** The one-time token, unwrapped — the control plane feeds it into `verifyEmail`. */
  readonly token: string;
  readonly url: string;
  readonly tenantId: string;
}

/** The recording auth stack: the real `AuthService` over an in-memory store. */
export interface RecordingAuth {
  readonly tenantId: string;
  readonly auth: AuthService;
  /** Every e-mail the service sent, in order — tokens included. */
  readonly emails: ReadonlyArray<RecordedAuthEmail>;
}

/**
 * The auth composition an e2e entrypoint needs: the real `makeAuth` service
 * over an in-memory store with an allow-all rate limiter and a recording
 * e-mail sender, so the control plane can complete e-mail verification
 * without a mailbox. Compose this in `src/e2e-main.ts` (never production) and
 * pass it to `TestControl.layer({ auth: ... })`.
 *
 * ```ts
 * const auth = RecordingAuth.make({ tenantId: "my-app", baseUrl: new URL("http://localhost:3000") });
 * const control = TestControl.layer({ auth, ... });
 * ```
 */
export const RecordingAuth = {
  make: (options: {
    readonly tenantId: string;
    readonly baseUrl: URL;
    readonly tenant?: Partial<TenantAuthConfig>;
  }): RecordingAuth => {
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
    return { tenantId: options.tenantId, auth, emails };
  },
};
