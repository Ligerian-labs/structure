import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted } from "effect";
import {
  makeLocalStorage,
  makeS3Storage,
  ObjectNotFound,
  objectKey,
  type Storage,
  StorageUnavailable,
  storageReadinessCheck,
} from "../src/index.js";
import { startS3Stub } from "./s3.stub.js";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

/** A driver double that answers a probe but would blow up on a listing. */
const probeOnly = (head: Storage["head"]): Storage & { readonly listed: () => number } => {
  let listed = 0;
  return {
    listed: () => listed,
    put: () => Effect.die("unexpected put"),
    get: () => Effect.die("unexpected get"),
    head,
    delete: () => Effect.die("unexpected delete"),
    list: () =>
      Effect.sync(() => {
        listed += 1;
        return [];
      }),
  };
};

describe("storage readiness check", () => {
  test("probes one known key and never lists the store", async () => {
    const storage = probeOnly((key) => Effect.fail(new ObjectNotFound({ key })));
    const check = storageReadinessCheck(storage);
    expect(check.name).toBe("storage");
    expect(await run(check.run)).toBe(true);
    expect(storage.listed()).toBe(0);
  });

  test("a missing probe object means ready; an unavailable driver means not ready", async () => {
    const missing = probeOnly((key) => Effect.fail(new ObjectNotFound({ key })));
    expect(await run(storageReadinessCheck(missing).run)).toBe(true);
    const down = probeOnly(() =>
      Effect.fail(new StorageUnavailable({ driver: "test", operation: "head", reason: "down" })),
    );
    expect(await run(storageReadinessCheck(down).run)).toBe(false);
  });

  test("against the S3 stub the probe is one HEAD, no ListObjects", async () => {
    const stub = await startS3Stub();
    try {
      const storage = makeS3Storage({
        bucket: "stub-bucket",
        region: "us-east-1",
        accessKeyId: "test-access-key",
        secretAccessKey: Redacted.make("test-secret-key"),
        endpoint: stub.url,
      });
      expect(await run(storageReadinessCheck(storage).run)).toBe(true);
      expect(stub.requests.map((request) => request.method)).toEqual(["HEAD"]);
      expect(stub.requests.some((request) => request.path === "/stub-bucket")).toBe(false);
    } finally {
      await stub.close();
    }
  });

  test("against a local root the probe answers without reading any sidecar", async () => {
    const root = await mkdtemp(join(tmpdir(), "structure-readiness-"));
    try {
      const storage = makeLocalStorage({ rootDir: root });
      const key = await run(objectKey("files/one.bin"));
      await run(storage.put({ key, body: new Uint8Array([1]), contentType: "text/plain" }));
      expect(await run(storageReadinessCheck(storage).run)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
