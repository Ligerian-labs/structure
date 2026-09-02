import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import {
  isValidKey,
  makeLocalStorage,
  ObjectNotFound,
  objectKey,
  randomObjectKey,
  StorageUnavailable,
} from "../src/index.js";
import { registerStorageScenarios, type StorageHarness } from "./scenarios.js";

const make = async (): Promise<StorageHarness & { readonly rootDir: string }> => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "structure-storage-"));
  const storage = makeLocalStorage({ rootDir });
  return {
    storage,
    rootDir,
    close: async () => {
      await fs.rm(rootDir, { recursive: true, force: true });
    },
  };
};

describe("Local storage driver", () => {
  registerStorageScenarios("local", make);

  test("path traversal through the driver layer fails closed", async () => {
    const harness = await make();
    try {
      const error = await Effect.runPromise(
        Effect.flip(harness.storage.get("..%2Fescape" as never)),
      );
      expect([ObjectNotFound, StorageUnavailable].some((klass) => error instanceof klass)).toBe(
        true,
      );
    } finally {
      await harness.close();
    }
  });

  test("writes objects with owner-only permissions under the root", async () => {
    const harness = await make();
    try {
      const key = await Effect.runPromise(objectKey("objects/perm.bin"));
      await Effect.runPromise(
        harness.storage.put({ key, body: new Uint8Array([1, 2, 3]), contentType: "text/plain" }),
      );
      const stat = await fs.stat(path.join(harness.rootDir, "objects/perm.bin"));
      expect(stat.mode & 0o777).toBe(0o600);
      const listed = await Effect.runPromise(harness.storage.list("objects/"));
      expect(listed.map((object) => object.key as string)).toContain("objects/perm.bin");
    } finally {
      await harness.close();
    }
  });
});

describe("Object keys", () => {
  test("reject traversal, absolute, and malformed keys", () => {
    expect(isValidKey("../etc/passwd")).toBe(false);
    expect(isValidKey("objects/../../etc/passwd")).toBe(false);
    expect(isValidKey("/absolute")).toBe(false);
    expect(isValidKey("trailing/")).toBe(false);
    expect(isValidKey("double//slash")).toBe(false);
    expect(isValidKey("back\\slash")).toBe(false);
    expect(isValidKey("")).toBe(false);
    expect(isValidKey("objects/report.v2.csv")).toBe(true);
    expect(isValidKey("a")).toBe(true);
  });

  test("objectKey fails with a typed error for invalid keys", async () => {
    const error = await Effect.runPromise(Effect.flip(objectKey("../escape")));
    expect(error._tag).toBe("StorageValidationError");
  });

  test("randomObjectKey generates valid unguessable keys", async () => {
    const first = await Effect.runPromise(randomObjectKey({ extension: ".png" }));
    const second = await Effect.runPromise(randomObjectKey({ extension: ".png" }));
    expect(isValidKey(first)).toBe(true);
    expect(isValidKey(second)).toBe(true);
    expect(first).not.toBe(second);
    expect(first.endsWith(".png")).toBe(true);
  });
});
