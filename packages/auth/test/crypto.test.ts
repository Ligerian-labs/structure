import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { argon2id } from "../src/index.js";

describe("argon2id", () => {
  test("encodes passwords with Argon2id and verifies without exposing the password", async () => {
    const hasher = argon2id({ memoryCostKiB: 19_456, timeCost: 2 });
    const encoded = await Effect.runPromise(hasher.hash("correct horse battery staple"));

    expect(encoded).toStartWith("$argon2id$");
    expect(encoded).not.toContain("correct horse battery staple");
    expect(await Effect.runPromise(hasher.verify("correct horse battery staple", encoded))).toBe(
      true,
    );
    expect(await Effect.runPromise(hasher.verify("wrong", encoded))).toBe(false);
  });
});
