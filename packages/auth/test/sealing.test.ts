import { describe, expect, test } from "bun:test";
import { Effect, Redacted } from "effect";
import { sha256 } from "../src/crypto.js";
import { AuthDependencyError, AuthValidationError } from "../src/errors.js";
import { makeSecondFactorSealer } from "../src/sealing.js";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);
const secret = Redacted.make("an-instance-secret-of-thirty-two-plus-characters");
const encoder = new TextEncoder();

describe("second-factor sealing", () => {
  test("every seal of the same secret uses a fresh IV and a different ciphertext", async () => {
    const sealer = makeSecondFactorSealer(secret);
    const sealed = await Promise.all(
      Array.from({ length: 6 }, () => run(sealer.seal("JBSWY3DPEHPK3PXP"))),
    );
    const ivs = new Set(sealed.map((value) => value.split(":")[1]));
    const ciphertexts = new Set(sealed.map((value) => value.split(":")[2]));
    expect(ivs.size).toBe(6);
    expect(ciphertexts.size).toBe(6);
    for (const value of sealed) {
      expect(value.startsWith("v1:")).toBe(true);
      expect(await run(sealer.open(value))).toBe("JBSWY3DPEHPK3PXP");
    }
    // Twelve-byte IVs, as AES-GCM expects.
    expect(Buffer.from(sealed[0]?.split(":")[1] ?? "", "base64url")).toHaveLength(12);
  });

  test("a wrong recovery code never matches, whatever its shape", async () => {
    const sealer = makeSecondFactorSealer(secret);
    const stored = await run(sealer.hashRecoveryCode("abcde-fghij"));
    expect(await run(sealer.matchRecoveryCode("abcde-fghij", stored, sha256))).toBe(true);
    const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
    const randomCode = () =>
      Array.from({ length: 10 }, () => alphabet[Math.floor(Math.random() * 32)])
        .join("")
        .replace(/^(.{5})(.{5})$/u, "$1-$2");
    let matches = 0;
    for (let index = 0; index < 500; index++) {
      const guess = randomCode();
      if (guess === "abcde-fghij") continue;
      if (await run(sealer.matchRecoveryCode(guess, stored, sha256))) matches += 1;
    }
    expect(matches).toBe(0);
    // Near misses: one character off at either end, a prefix, an extension.
    for (const near of ["abcde-fghik", "bbcde-fghij", "abcde-fghi", "abcde-fghijk", ""]) {
      expect(await run(sealer.matchRecoveryCode(near, stored, sha256))).toBe(false);
    }
    // The same code under another instance secret is a different world.
    const other = makeSecondFactorSealer(
      Redacted.make("another-instance-secret-of-thirty-two-chars"),
    );
    expect(await run(other.matchRecoveryCode("abcde-fghij", stored, sha256))).toBe(false);
  });

  test("keys are derived under the documented HKDF labels", async () => {
    const sealer = makeSecondFactorSealer(secret);
    const salt = new Uint8Array(16);
    crypto.getRandomValues(salt);
    const macUnder = async (info: string): Promise<string> => {
      const base = await crypto.subtle.importKey(
        "raw",
        encoder.encode(Redacted.value(secret)),
        "HKDF",
        false,
        ["deriveKey"],
      );
      const key = await crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: encoder.encode("structure-auth/second-factor"),
          info: encoder.encode(info),
        },
        base,
        { name: "HMAC", hash: "SHA-256", length: 256 },
        false,
        ["sign"],
      );
      const input = new Uint8Array([...salt, ...encoder.encode("abcde-fghij")]);
      const digest = await crypto.subtle.sign("HMAC", key, input);
      return `v1:${Buffer.from(salt).toString("base64url")}:${Buffer.from(digest).toString("base64url")}`;
    };
    // The recovery-code key is the one under "recovery-code/v1"...
    expect(
      await run(
        sealer.matchRecoveryCode("abcde-fghij", await macUnder("recovery-code/v1"), sha256),
      ),
    ).toBe(true);
    // ...and never the TOTP-secret key, nor an unlabelled derivation.
    expect(
      await run(sealer.matchRecoveryCode("abcde-fghij", await macUnder("totp-secret/v1"), sha256)),
    ).toBe(false);
    expect(await run(sealer.matchRecoveryCode("abcde-fghij", await macUnder(""), sha256))).toBe(
      false,
    );
  });
});

describe("recovery-code comparison width", () => {
  test("a stored digest differing in any single byte, or in length, never matches", async () => {
    const sealer = makeSecondFactorSealer(secret);
    const stored = await run(sealer.hashRecoveryCode("abcde-fghij"));
    const [version, salt, mac] = stored.split(":");
    const digest = Buffer.from(mac ?? "", "base64url");
    expect(digest).toHaveLength(32);
    const variant = (bytes: Buffer): string =>
      `${version}:${salt}:${Buffer.from(bytes).toString("base64url")}`;
    expect(await run(sealer.matchRecoveryCode("abcde-fghij", stored, sha256))).toBe(true);
    for (const index of [0, 1, 2, 15, 16, 29, 30, 31]) {
      const flipped = Buffer.from(digest);
      flipped[index] = (flipped[index] ?? 0) ^ 0x01;
      expect(await run(sealer.matchRecoveryCode("abcde-fghij", variant(flipped), sha256))).toBe(
        false,
      );
    }
    expect(
      await run(sealer.matchRecoveryCode("abcde-fghij", variant(digest.subarray(0, 31)), sha256)),
    ).toBe(false);
    expect(
      await run(
        sealer.matchRecoveryCode(
          "abcde-fghij",
          variant(Buffer.concat([digest, Buffer.from([0])])),
          sha256,
        ),
      ),
    ).toBe(false);
    expect(
      await run(sealer.matchRecoveryCode("abcde-fghij", variant(Buffer.alloc(0)), sha256)),
    ).toBe(false);
  });
});

describe("malformed sealed values", () => {
  test("fail on the typed error channel, never by throwing", async () => {
    const sealer = makeSecondFactorSealer(secret);
    for (const malformed of [
      "v1:",
      "v1::",
      "v1:AAAA",
      "v1:AAAA:BBBB:CCCC",
      "v1:!!!:!!!",
      "v1:a b:c d",
    ]) {
      const error = await run(Effect.flip(sealer.open(malformed)));
      expect(error).toBeInstanceOf(AuthValidationError);
      expect(error.classification).toBe("permanent");
      expect(await run(sealer.matchRecoveryCode("abcde-fghij", malformed, sha256))).toBe(false);
    }
    // A well-formed value under the wrong key is a dependency failure, not a validation one.
    const other = makeSecondFactorSealer(
      Redacted.make("another-instance-secret-of-thirty-two-chars"),
    );
    const sealed = await run(sealer.seal("JBSWY3DPEHPK3PXP"));
    expect(await run(Effect.flip(other.open(sealed)))).toBeInstanceOf(AuthDependencyError);
  });
});
