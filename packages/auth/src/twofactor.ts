import { Effect, Redacted } from "effect";
import { randomToken, sha256 } from "./crypto.js";
import {
  type AuthDependencyError,
  type AuthFailureClass,
  AuthValidationError,
  InvalidAuthToken,
  InvalidCredentials,
  RateLimitExceeded,
} from "./errors.js";
import type { TenantAuthConfig, TenantId } from "./model.js";
import {
  type AuthAction,
  type AuthAuditSink,
  noOpAuthAuditSink,
  type RateLimiter,
} from "./ports.js";
import { makeSecondFactorSealer } from "./sealing.js";
import type { AuthPrimitives, AuthService, AuthServiceError } from "./service.js";
import type { AuthStore } from "./store.js";
import { generateRecoveryCodes, generateTotpSecret, matchTotpCode, totpQrPayload } from "./totp.js";

const DEFAULT_LOCKOUT_THRESHOLD = 5;
const DEFAULT_LOCKOUT_COOLDOWN = 15 * 60 * 1_000;

export interface TotpServiceOptions {
  readonly store: AuthStore;
  readonly auth: AuthService;
  readonly resolveTenant: (
    tenantId: TenantId,
  ) => Effect.Effect<TenantAuthConfig, AuthDependencyError | AuthValidationError>;
  readonly rateLimiter: RateLimiter;
  /**
   * The instance secret the second factor is sealed under at rest: the
   * TOTP secret is encrypted (AES-256-GCM) and recovery codes are hashed
   * with a per-code salt (HMAC-SHA-256), both under keys derived from it
   * (HKDF-SHA-256 with a purpose label), so a database read alone yields no
   * second factor. Enrollments stored before sealing existed keep verifying
   * and are sealed on their next successful verification. Rotating the
   * secret invalidates every enrollment sealed under the old one.
   */
  readonly secret: Redacted.Redacted<string>;
  readonly audit?: AuthAuditSink;
  /** Failed attempts before lockout. Default 5. */
  readonly lockoutThreshold?: number;
  /** Lockout duration once the threshold trips. Default 15 minutes. */
  readonly lockoutCooldownMillis?: number;
  readonly primitives?: Partial<AuthPrimitives>;
}

export interface EnrollmentSecret {
  /** Base32 secret — shown once, fed to the user's authenticator via QR. */
  readonly secretBase32: string;
  readonly otpauthUrl: string;
}

export interface ConfirmedEnrollment {
  /** Single-use recovery codes — shown exactly once, stored only as hashes. */
  readonly recoveryCodes: ReadonlyArray<Redacted.Redacted<string>>;
}

export type TotpServiceError = AuthServiceError | RateLimitExceeded;

/**
 * TOTP two-factor: enrollment, verification with lockout, recovery codes,
 * and session elevation. Sessions of users with a confirmed enrollment are
 * born `2fa-pending` (no `elevatedAt`); `verify` elevates them. A locked
 * second factor falls back to owner-initiated recovery — never to bypass:
 * verification keeps failing until the cooldown passes or the enrollment is
 * removed through the app's owner flow.
 */
export interface TotpService {
  readonly beginEnrollment: (
    tenantId: TenantId,
    sessionToken: Redacted.Redacted<string>,
  ) => Effect.Effect<EnrollmentSecret, TotpServiceError>;
  readonly confirmEnrollment: (
    tenantId: TenantId,
    sessionToken: Redacted.Redacted<string>,
    code: string,
  ) => Effect.Effect<ConfirmedEnrollment, TotpServiceError>;
  /** Accepts a TOTP code or a recovery code; elevates the session on success. */
  readonly verify: (
    tenantId: TenantId,
    sessionToken: Redacted.Redacted<string>,
    code: string,
  ) => Effect.Effect<{ readonly elevated: true }, TotpServiceError>;
  /**
   * Removes the enrollment on a TOTP code or a recovery code (consumed),
   * with the same lockout accounting as `verify`: the owner of a lost
   * authenticator re-establishes a factor with the codes they kept.
   */
  readonly unenroll: (
    tenantId: TenantId,
    sessionToken: Redacted.Redacted<string>,
    code: string,
  ) => Effect.Effect<void, TotpServiceError>;
  /**
   * Operator break-glass for the lost-authenticator case: removes the
   * user's enrollment (pending or confirmed) without any code, audited as
   * `totp-reset` with the operator as `actor`. Expose it only behind the
   * application's operator surface (a CLI, a superadmin route), never to
   * the user. A no-op, unaudited, when there is nothing to remove.
   */
  readonly resetSecondFactor: (
    tenantId: TenantId,
    userId: string,
    operator: { readonly actor: string },
  ) => Effect.Effect<void, TotpServiceError>;
  /** True while a confirmed enrollment leaves this session 2fa-pending. */
  readonly sessionRequiresElevation: (
    tenantId: TenantId,
    sessionToken: Redacted.Redacted<string>,
  ) => Effect.Effect<boolean, TotpServiceError>;
  /** True when the user has a confirmed enrollment (for the sign-in hook). */
  readonly isEnrolled: (
    tenantId: TenantId,
    userId: string,
  ) => Effect.Effect<boolean, TotpServiceError>;
}

const isRecoveryCode = (code: string): boolean => /^[a-z2-7]{5}-[a-z2-7]{5}$/u.test(code);

export const makeTotp = (options: TotpServiceOptions): TotpService => {
  const primitives: AuthPrimitives = {
    now: options.primitives?.now ?? (() => new Date()),
    randomToken: options.primitives?.randomToken ?? randomToken,
    hashToken: options.primitives?.hashToken ?? sha256,
  };
  const threshold = options.lockoutThreshold ?? DEFAULT_LOCKOUT_THRESHOLD;
  const cooldown = options.lockoutCooldownMillis ?? DEFAULT_LOCKOUT_COOLDOWN;
  const audit = options.audit ?? noOpAuthAuditSink;
  const sealer = makeSecondFactorSealer(options.secret);

  /** The stored entry behind `code`, if any; every entry is compared. */
  const recoveryEntryFor = (hashes: ReadonlyArray<string>, code: string) =>
    Effect.map(
      Effect.all(
        hashes.map((stored) => sealer.matchRecoveryCode(code, stored, primitives.hashToken)),
      ),
      (matches) => hashes.find((_, index) => matches[index] === true),
    );

  /** Seals a plaintext (pre-sealing) secret in place; a no-op once sealed. */
  const sealLegacySecret = (tenantId: TenantId, userId: string, stored: string) =>
    sealer.isSealed(stored)
      ? Effect.void
      : sealer
          .seal(stored)
          .pipe(
            Effect.flatMap((sealed) => options.store.replaceTotpSecret(tenantId, userId, sealed)),
          );

  const limit = (tenantId: TenantId, action: AuthAction, key: string) =>
    primitives
      .hashToken(key)
      .pipe(Effect.flatMap((keyHash) => options.rateLimiter.check({ tenantId, action, keyHash })));

  const recordAudit = (
    tenantId: TenantId,
    action: Parameters<AuthAuditSink["record"]>[0]["action"],
    userId: string,
  ) => audit.record({ tenantId, action, outcome: "succeeded", userId });

  const sessionUser = (tenantId: TenantId, sessionToken: Redacted.Redacted<string>) =>
    Effect.gen(function* () {
      const session = yield* options.auth.getSession(tenantId, sessionToken);
      return session.user;
    });

  const confirmedEnrollmentOrNone = (tenantId: TenantId, userId: string) =>
    Effect.map(options.store.findTotp(tenantId, userId), (record) =>
      record?.confirmed ? record : undefined,
    );

  const anyEnrollment = (tenantId: TenantId, userId: string) =>
    Effect.map(options.store.findTotp(tenantId, userId), (record) => record);

  const lockoutError = (lockedUntil: Date): RateLimitExceeded =>
    new RateLimitExceeded({
      action: "totp-verify",
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((lockedUntil.getTime() - primitives.now().getTime()) / 1_000),
      ),
    });

  return {
    beginEnrollment: (tenantId, sessionToken) =>
      Effect.gen(function* () {
        yield* options.resolveTenant(tenantId);
        yield* limit(tenantId, "totp-enroll", Redacted.value(sessionToken));
        const user = yield* sessionUser(tenantId, sessionToken);
        const existing = yield* confirmedEnrollmentOrNone(tenantId, user.id);
        if (existing !== undefined) {
          return yield* new AuthValidationError({
            field: "totp",
            reason: "is already enrolled; unenroll first to re-enroll",
          });
        }
        const secretBase32 = generateTotpSecret();
        yield* options.store.putTotpSecret({
          tenantId,
          userId: user.id,
          secretBase32: yield* sealer.seal(secretBase32),
          confirmed: false,
          recoveryCodeHashes: [],
          failedAttempts: 0,
          enrolledAt: primitives.now(),
        });
        return {
          secretBase32,
          otpauthUrl: totpQrPayload({
            secretBase32,
            account: user.email ?? user.id,
            issuer: new URL((yield* options.resolveTenant(tenantId)).baseUrl.toString()).hostname,
          }),
        };
      }),
    confirmEnrollment: (tenantId, sessionToken, code) =>
      Effect.gen(function* () {
        yield* options.resolveTenant(tenantId);
        yield* limit(tenantId, "totp-confirm", Redacted.value(sessionToken));
        const user = yield* sessionUser(tenantId, sessionToken);
        const pending = yield* anyEnrollment(tenantId, user.id);
        if (pending === undefined || pending.confirmed) {
          return yield* new InvalidAuthToken({ purpose: "totp-enrollment" });
        }
        const secretBase32 = yield* sealer.open(pending.secretBase32);
        const step = yield* matchTotpCode(secretBase32, code, primitives.now());
        if (step === undefined) return yield* new InvalidCredentials({ reason: "totp" });
        const recoveryCodes = generateRecoveryCodes();
        const hashes = yield* Effect.all(
          recoveryCodes.map((codeText) => sealer.hashRecoveryCode(codeText)),
        );
        yield* options.store.confirmTotp(tenantId, user.id, hashes, primitives.now());
        // The confirming code is spent too: it must not elevate a session next.
        yield* options.store.markTotpStepUsed(tenantId, user.id, step);
        yield* recordAudit(tenantId, "totp-confirm", user.id);
        return { recoveryCodes: recoveryCodes.map((codeText) => Redacted.make(codeText)) };
      }),
    verify: (tenantId, sessionToken, code) =>
      Effect.gen(function* () {
        yield* options.resolveTenant(tenantId);
        yield* limit(tenantId, "totp-verify", Redacted.value(sessionToken));
        const user = yield* sessionUser(tenantId, sessionToken);
        const enrollment = yield* confirmedEnrollmentOrNone(tenantId, user.id);
        if (enrollment === undefined) {
          return yield* new InvalidAuthToken({ purpose: "totp-enrollment" });
        }
        if (
          enrollment.lockedUntil !== undefined &&
          enrollment.lockedUntil.getTime() > primitives.now().getTime()
        ) {
          // Locked second factors never bypass: they wait out the cooldown.
          return yield* lockoutError(enrollment.lockedUntil);
        }
        const secretBase32 = yield* sealer.open(enrollment.secretBase32);
        const step = yield* matchTotpCode(secretBase32, code, primitives.now());
        // A valid code is accepted once: the step is claimed atomically, and
        // a second presentation (any session, any purpose) is a plain failure.
        if (
          step !== undefined &&
          (yield* options.store.markTotpStepUsed(tenantId, user.id, step))
        ) {
          yield* sealLegacySecret(tenantId, user.id, enrollment.secretBase32);
          yield* options.store.resetTotpFailures(tenantId, user.id);
          yield* elevate(tenantId, sessionToken, user.id);
          return { elevated: true as const };
        }
        if (isRecoveryCode(code)) {
          const entry = yield* recoveryEntryFor(enrollment.recoveryCodeHashes, code);
          const consumed =
            entry !== undefined &&
            (yield* options.store.consumeRecoveryCode(tenantId, user.id, entry));
          if (consumed) {
            yield* options.store.resetTotpFailures(tenantId, user.id);
            yield* elevate(tenantId, sessionToken, user.id);
            return { elevated: true as const };
          }
        }
        const outcome = yield* options.store.recordTotpFailure({
          tenantId,
          userId: user.id,
          threshold,
          cooldownMillis: cooldown,
          now: primitives.now(),
        });
        if (outcome.locked && outcome.lockedUntil !== undefined) {
          yield* audit.record({
            tenantId,
            action: "totp-locked",
            outcome: "succeeded",
            userId: user.id,
          });
          return yield* lockoutError(outcome.lockedUntil);
        }
        return yield* new InvalidCredentials({ reason: "totp" });
      }),
    unenroll: (tenantId, sessionToken, code) =>
      Effect.gen(function* () {
        yield* options.resolveTenant(tenantId);
        yield* limit(tenantId, "totp-unenroll", Redacted.value(sessionToken));
        const user = yield* sessionUser(tenantId, sessionToken);
        const enrollment = yield* confirmedEnrollmentOrNone(tenantId, user.id);
        if (enrollment === undefined) {
          return yield* new InvalidAuthToken({ purpose: "totp-enrollment" });
        }
        if (
          enrollment.lockedUntil !== undefined &&
          enrollment.lockedUntil.getTime() > primitives.now().getTime()
        ) {
          return yield* lockoutError(enrollment.lockedUntil);
        }
        const secretBase32 = yield* sealer.open(enrollment.secretBase32);
        const step = yield* matchTotpCode(secretBase32, code, primitives.now());
        const entry = isRecoveryCode(code)
          ? yield* recoveryEntryFor(enrollment.recoveryCodeHashes, code)
          : undefined;
        const accepted =
          step !== undefined
            ? yield* options.store.markTotpStepUsed(tenantId, user.id, step)
            : entry !== undefined &&
              (yield* options.store.consumeRecoveryCode(tenantId, user.id, entry));
        if (!accepted) {
          const outcome = yield* options.store.recordTotpFailure({
            tenantId,
            userId: user.id,
            threshold,
            cooldownMillis: cooldown,
            now: primitives.now(),
          });
          if (outcome.locked && outcome.lockedUntil !== undefined) {
            yield* audit.record({
              tenantId,
              action: "totp-locked",
              outcome: "succeeded",
              userId: user.id,
            });
            return yield* lockoutError(outcome.lockedUntil);
          }
          return yield* new InvalidCredentials({ reason: "totp" });
        }
        yield* options.store.removeTotp(tenantId, user.id);
        yield* recordAudit(tenantId, "totp-unenroll", user.id);
      }),
    resetSecondFactor: (tenantId, userId, operator) =>
      Effect.gen(function* () {
        yield* options.resolveTenant(tenantId);
        const enrollment = yield* anyEnrollment(tenantId, userId);
        if (enrollment === undefined) return;
        yield* options.store.removeTotp(tenantId, userId);
        yield* audit.record({
          tenantId,
          action: "totp-reset",
          outcome: "succeeded",
          userId,
          actor: operator.actor,
        });
      }),
    sessionRequiresElevation: (tenantId, sessionToken) =>
      Effect.gen(function* () {
        yield* options.resolveTenant(tenantId);
        const tokenHash = yield* primitives.hashToken(Redacted.value(sessionToken));
        const session = yield* options.store.findSession(tenantId, tokenHash, primitives.now());
        if (session === undefined) return yield* new InvalidCredentials({ reason: "session" });
        if (session.elevatedAt !== undefined) return false;
        const enrollment = yield* confirmedEnrollmentOrNone(tenantId, session.userId);
        return enrollment !== undefined;
      }),
    isEnrolled: (tenantId, userId) =>
      Effect.map(confirmedEnrollmentOrNone(tenantId, userId), (record) => record !== undefined),
  };

  function elevate(
    tenantId: TenantId,
    sessionToken: Redacted.Redacted<string>,
    userId: string,
  ): Effect.Effect<void, TotpServiceError> {
    return Effect.gen(function* () {
      const tokenHash = yield* primitives.hashToken(Redacted.value(sessionToken));
      yield* options.store.elevateSession(tenantId, tokenHash, primitives.now());
      yield* recordAudit(tenantId, "totp-verify", userId);
    });
  }
};

export type { AuthFailureClass };
