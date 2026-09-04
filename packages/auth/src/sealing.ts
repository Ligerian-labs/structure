import { Effect, Redacted } from "effect";
import { decodeBase64Url, encodeBase64Url } from "./crypto.js";
import { AuthDependencyError, AuthValidationError } from "./errors.js";

const VERSION = "v1";
const HKDF_SALT = "structure-auth/second-factor";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Seals second-factor material for storage under keys derived from the
 * instance secret (HKDF-SHA-256, one purpose label per key), so a database
 * read alone yields no second factor:
 *
 * - the TOTP secret is encrypted with AES-256-GCM: `v1:<iv>:<ciphertext>`;
 * - a recovery code is hashed with HMAC-SHA-256 over a fresh 16-byte salt:
 *   `v1:<salt>:<mac>`, so an offline guess needs the instance secret and a
 *   precomputed table transfers between neither users nor instances.
 *
 * A stored value without the version prefix predates sealing (a plaintext
 * base32 secret, an unsalted digest of a recovery code): `open` passes it
 * through and `matchRecoveryCode` compares it through the legacy digest, so
 * existing enrollments keep working and are sealed on their next use.
 */
export interface SecondFactorSealer {
  readonly seal: (secretBase32: string) => Effect.Effect<string, SealingError>;
  readonly open: (stored: string) => Effect.Effect<string, SealingError>;
  readonly isSealed: (stored: string) => boolean;
  readonly hashRecoveryCode: (code: string) => Effect.Effect<string, SealingError>;
  readonly matchRecoveryCode: (
    code: string,
    stored: string,
    legacyHash: (code: string) => Effect.Effect<string, AuthDependencyError>,
  ) => Effect.Effect<boolean, SealingError>;
}

export type SealingError = AuthDependencyError | AuthValidationError;

interface DerivedKeys {
  readonly aes: CryptoKey;
  readonly mac: CryptoKey;
}

const constantTimeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) {
    diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return diff === 0;
};

const randomBytes = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
};

const buffer = (value: Uint8Array): ArrayBuffer => value as unknown as ArrayBuffer;

/**
 * Splits a stored `v1:<a>:<b>` value into its two byte segments. A value of
 * another shape, or with segments that are not base64url, is a typed
 * validation failure on the Effect channel, never an exception.
 */
const parse = (
  stored: string,
): Effect.Effect<
  { readonly first: Uint8Array; readonly second: Uint8Array },
  AuthValidationError
> => {
  const malformed = () =>
    new AuthValidationError({ field: "sealed-value", reason: "is malformed" });
  const [version, first, second, ...rest] = stored.split(":");
  if (
    version !== VERSION ||
    first === undefined ||
    second === undefined ||
    first.length === 0 ||
    second.length === 0 ||
    rest.length > 0
  ) {
    return Effect.fail(malformed());
  }
  return Effect.try({
    try: () => ({ first: decodeBase64Url(first), second: decodeBase64Url(second) }),
    catch: malformed,
  });
};

const saltedCode = (salt: Uint8Array, code: string): Uint8Array => {
  const codeBytes = encoder.encode(code);
  const output = new Uint8Array(salt.length + codeBytes.length);
  output.set(salt, 0);
  output.set(codeBytes, salt.length);
  return output;
};

const deriveKeys = async (secret: string): Promise<DerivedKeys> => {
  const base = await crypto.subtle.importKey("raw", buffer(encoder.encode(secret)), "HKDF", false, [
    "deriveKey",
  ]);
  const derive = (
    info: string,
    algorithm:
      | { readonly name: "AES-GCM"; readonly length: number }
      | { readonly name: "HMAC"; readonly hash: string; readonly length: number },
    usages: ReadonlyArray<"encrypt" | "decrypt" | "sign">,
  ): Promise<CryptoKey> =>
    crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: buffer(encoder.encode(HKDF_SALT)),
        info: buffer(encoder.encode(info)),
      },
      base,
      algorithm,
      false,
      [...usages],
    );
  return {
    aes: await derive("totp-secret/v1", { name: "AES-GCM", length: 256 }, ["encrypt", "decrypt"]),
    mac: await derive("recovery-code/v1", { name: "HMAC", hash: "SHA-256", length: 256 }, ["sign"]),
  };
};

export const makeSecondFactorSealer = (secret: Redacted.Redacted<string>): SecondFactorSealer => {
  let derived: Promise<DerivedKeys> | undefined;
  const failure =
    (operation: string) =>
    (cause: unknown): AuthDependencyError =>
      new AuthDependencyError({ dependency: "second-factor-sealing", operation, cause });
  const keys = (): Effect.Effect<DerivedKeys, SealingError> =>
    Redacted.value(secret).length === 0
      ? Effect.fail(new AuthValidationError({ field: "secret", reason: "must not be empty" }))
      : Effect.tryPromise({
          try: () => {
            if (derived === undefined) {
              const pending = deriveKeys(Redacted.value(secret));
              pending.catch(() => {
                derived = undefined;
              });
              derived = pending;
            }
            return derived;
          },
          catch: failure("derive-keys"),
        });
  const isSealed = (stored: string): boolean => stored.startsWith(`${VERSION}:`);

  return {
    isSealed,
    seal: (secretBase32) =>
      keys().pipe(
        Effect.flatMap(({ aes }) =>
          Effect.tryPromise({
            try: async () => {
              const iv = randomBytes(12);
              const ciphertext = await crypto.subtle.encrypt(
                { name: "AES-GCM", iv: buffer(iv) },
                aes,
                buffer(encoder.encode(secretBase32)),
              );
              return `${VERSION}:${encodeBase64Url(iv)}:${encodeBase64Url(new Uint8Array(ciphertext))}`;
            },
            catch: failure("seal-totp-secret"),
          }),
        ),
      ),
    open: (stored) =>
      isSealed(stored)
        ? Effect.all([keys(), parse(stored)]).pipe(
            Effect.flatMap(([{ aes }, { first: iv, second: ciphertext }]) =>
              Effect.tryPromise({
                try: async () => {
                  const plaintext = await crypto.subtle.decrypt(
                    { name: "AES-GCM", iv: buffer(iv) },
                    aes,
                    buffer(ciphertext),
                  );
                  return decoder.decode(plaintext);
                },
                catch: failure("open-totp-secret"),
              }),
            ),
          )
        : Effect.succeed(stored),
    hashRecoveryCode: (code) =>
      keys().pipe(
        Effect.flatMap(({ mac }) =>
          Effect.tryPromise({
            try: async () => {
              const salt = randomBytes(16);
              const digest = await crypto.subtle.sign("HMAC", mac, buffer(saltedCode(salt, code)));
              return `${VERSION}:${encodeBase64Url(salt)}:${encodeBase64Url(new Uint8Array(digest))}`;
            },
            catch: failure("hash-recovery-code"),
          }),
        ),
      ),
    matchRecoveryCode: (code, stored, legacyHash) =>
      isSealed(stored)
        ? Effect.all([keys(), parse(stored)]).pipe(
            Effect.flatMap(([{ mac }, { first: salt, second: expected }]) =>
              Effect.tryPromise({
                try: async () => {
                  const digest = await crypto.subtle.sign(
                    "HMAC",
                    mac,
                    buffer(saltedCode(salt, code)),
                  );
                  return constantTimeEqual(new Uint8Array(digest), expected);
                },
                catch: failure("match-recovery-code"),
              }),
            ),
            // A malformed entry matches nothing; it is not a failure of the call.
            Effect.catchTag("AuthValidationError", () => Effect.succeed(false)),
          )
        : Effect.map(legacyHash(code), (digest) =>
            constantTimeEqual(encoder.encode(digest), encoder.encode(stored)),
          ),
  };
};
