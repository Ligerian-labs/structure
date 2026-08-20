import { password as bunPassword } from "bun";
import { Effect } from "effect";
import { AuthDependencyError, AuthValidationError } from "./errors.js";

export interface PasswordHasher {
  readonly hash: (
    password: string,
  ) => Effect.Effect<string, AuthDependencyError | AuthValidationError>;
  readonly verify: (
    password: string,
    encodedHash: string,
  ) => Effect.Effect<boolean, AuthDependencyError>;
}

export interface Argon2idOptions {
  readonly memoryCostKiB?: number;
  readonly timeCost?: number;
}

/** Bun-native Argon2id password hashing. */
export const argon2id = (options: Argon2idOptions = {}): PasswordHasher => {
  const memoryCost = options.memoryCostKiB ?? 65_536;
  const timeCost = options.timeCost ?? 3;
  const policyValid =
    Number.isInteger(memoryCost) &&
    memoryCost >= 19_456 &&
    memoryCost <= 1_048_576 &&
    Number.isInteger(timeCost) &&
    timeCost >= 2 &&
    timeCost <= 10;
  return {
    hash: (password) =>
      !policyValid
        ? Effect.fail(
            new AuthValidationError({
              field: "argon2id",
              reason: "requires 19456..1048576 KiB and 2..10 iterations",
            }),
          )
        : password.length === 0
          ? Effect.fail(new AuthValidationError({ field: "password", reason: "must not be empty" }))
          : Effect.tryPromise({
              try: () =>
                bunPassword.hash(password, { algorithm: "argon2id", memoryCost, timeCost }),
              catch: (cause) =>
                new AuthDependencyError({ dependency: "argon2id", operation: "hash", cause }),
            }),
    verify: (password, encodedHash) =>
      Effect.tryPromise({
        try: () => bunPassword.verify(password, encodedHash, "argon2id"),
        catch: (cause) =>
          new AuthDependencyError({ dependency: "argon2id", operation: "verify", cause }),
      }),
  };
};

export const encodeBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};

export const decodeBase64Url = (value: string): Uint8Array => {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

export const randomToken = (byteLength = 32): string => {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
};

export const sha256Bytes = (value: Uint8Array): Effect.Effect<Uint8Array, AuthDependencyError> =>
  Effect.tryPromise({
    try: () =>
      crypto.subtle
        .digest("SHA-256", Uint8Array.from(value).buffer)
        .then((digest) => new Uint8Array(digest)),
    catch: (cause) =>
      new AuthDependencyError({ dependency: "webcrypto", operation: "sha256", cause }),
  });

export const sha256 = (value: string): Effect.Effect<string, AuthDependencyError> =>
  sha256Bytes(new TextEncoder().encode(value)).pipe(Effect.map(encodeBase64Url));
