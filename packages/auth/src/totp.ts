import { Effect } from "effect";
import { AuthDependencyError, AuthValidationError } from "./errors.js";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 (no padding). */
export const base32Encode = (bytes: Uint8Array): string => {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
};

/** Decodes base32 (case-insensitive, padding- and space-tolerant). */
export const base32Decode = (input: string): Effect.Effect<Uint8Array, AuthValidationError> =>
  Effect.try({
    try: () => {
      const cleaned = input.replace(/[=\s]/gu, "").toUpperCase();
      let bits = 0;
      let value = 0;
      const out: Array<number> = [];
      for (const character of cleaned) {
        const index = BASE32_ALPHABET.indexOf(character);
        if (index < 0) throw new Error("invalid base32 character");
        value = (value << 5) | index;
        bits += 5;
        if (bits >= 8) {
          out.push((value >>> (bits - 8)) & 0xff);
          bits -= 8;
        }
      }
      return new Uint8Array(out);
    },
    catch: () => new AuthValidationError({ field: "secret", reason: "must be valid base32" }),
  });

/** A freshly generated TOTP secret (20 random bytes, base32-encoded). */
export const generateTotpSecret = (): string => {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return base32Encode(bytes);
};

const hmacSha1 = async (key: Uint8Array, message: Uint8Array): Promise<Uint8Array> => {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as unknown as ArrayBuffer,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", cryptoKey, message as unknown as ArrayBuffer),
  );
};

const counterBytes = (counter: number): Uint8Array => {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter % 2 ** 32);
  return new Uint8Array(buffer);
};

/** RFC 4226 HOTP, truncated to 6 digits. */
export const hotp = (
  secret: Uint8Array,
  counter: number,
): Effect.Effect<string, AuthDependencyError> =>
  Effect.tryPromise({
    try: async () => {
      const digest = await hmacSha1(secret, counterBytes(counter));
      const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
      const byte0 = digest[offset] ?? 0;
      const byte1 = digest[offset + 1] ?? 0;
      const byte2 = digest[offset + 2] ?? 0;
      const byte3 = digest[offset + 3] ?? 0;
      const binary =
        (((byte0 & 0x7f) << 24) |
          ((byte1 & 0xff) << 16) |
          ((byte2 & 0xff) << 8) |
          (byte3 & 0xff)) >>>
        0;
      return String(binary % 1_000_000).padStart(6, "0");
    },
    catch: (cause) =>
      new AuthDependencyError({ dependency: "hmac-sha1", operation: "hotp", cause }),
  }).pipe(
    Effect.mapError(
      (error): AuthDependencyError =>
        error instanceof AuthDependencyError
          ? error
          : new AuthDependencyError({ dependency: "hotp", operation: "compute" }),
    ),
  );

export const TOTP_STEP_SECONDS = 30;

const timeCounter = (at: Date): number => Math.floor(at.getTime() / 1_000 / TOTP_STEP_SECONDS);

/** The current 6-digit code for a secret (test/preview helper). */
export const totpCode = (
  secretBase32: string,
  at: Date,
): Effect.Effect<string, AuthDependencyError | AuthValidationError> =>
  base32Decode(secretBase32).pipe(Effect.flatMap((secret) => hotp(secret, timeCounter(at))));

/** Constant-time comparison for equal-length strings (6-digit codes). */
const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
};

/**
 * Matches a code against a secret at `at`, accepting codes from the
 * previous, current, and next step (window ±1), and answers the time step
 * that matched, or `undefined`. Comparison is constant-time and every
 * candidate is compared in a fixed order, so timing discloses neither
 * whether nor which step matched. The step is what lets a verifier remember
 * an accepted code and refuse its replay (RFC 6238 §5.2).
 */
export const matchTotpCode = (
  secretBase32: string,
  code: string,
  at: Date,
): Effect.Effect<number | undefined, AuthDependencyError | AuthValidationError> =>
  Effect.gen(function* () {
    if (!/^\d{6}$/u.test(code)) return undefined;
    const secret = yield* base32Decode(secretBase32);
    const current = timeCounter(at);
    const steps = [current - 1, current, current + 1];
    const candidates = yield* Effect.all(steps.map((step) => hotp(secret, step)));
    let matched: number | undefined;
    for (const [index, candidate] of candidates.entries()) {
      if (timingSafeEqual(candidate, code)) matched = steps[index];
    }
    return matched;
  });

/** True when `code` is valid for `secretBase32` at `at` (window ±1); see `matchTotpCode`. */
export const verifyTotpCode = (
  secretBase32: string,
  code: string,
  at: Date,
): Effect.Effect<boolean, AuthDependencyError | AuthValidationError> =>
  Effect.map(matchTotpCode(secretBase32, code, at), (step) => step !== undefined);

/** `otpauth://` provisioning URI for authenticator apps and QR payloads. */
export const totpQrPayload = (input: {
  readonly secretBase32: string;
  readonly account: string;
  readonly issuer: string;
}): string =>
  `otpauth://totp/${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}` +
  `?secret=${input.secretBase32}&issuer=${encodeURIComponent(input.issuer)}` +
  `&algorithm=SHA1&digits=6&period=${TOTP_STEP_SECONDS}`;

/** Generates `count` human-usable recovery codes (`xxxxx-xxxxx`). */
export const generateRecoveryCodes = (count = 10): ReadonlyArray<string> =>
  Array.from({ length: count }, () => {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    const text = base32Encode(bytes).toLowerCase();
    return `${text.slice(0, 5)}-${text.slice(5, 10)}`;
  });
