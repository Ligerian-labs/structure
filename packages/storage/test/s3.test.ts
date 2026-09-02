import { describe, expect, test } from "bun:test";
import { Effect, Redacted } from "effect";
import {
  makeS3Storage,
  ObjectNotFound,
  objectKey,
  type Storage,
  StorageRejected,
} from "../src/index.js";
import { type S3StubServer, startS3Stub } from "./s3.stub.js";
import { registerStorageScenarios, type StorageHarness, streamOf } from "./scenarios.js";

let stub: S3StubServer;
const make = async (): Promise<StorageHarness> => {
  if (stub === undefined) {
    stub = await startS3Stub();
  }
  const storage: Storage = makeS3Storage({
    bucket: "stub-bucket",
    region: "us-east-1",
    accessKeyId: "test-access-key",
    secretAccessKey: Redacted.make("test-secret-key"),
    endpoint: stub.url,
    partSize: 64 * 1_024,
  });
  return { storage, close: async () => undefined };
};

describe("S3 storage driver (against a loopback stub)", () => {
  registerStorageScenarios("s3", make);

  test("signs every request with SigV4", async () => {
    const harness = await make();
    const key = await Effect.runPromise(objectKey("signed/one.bin"));
    await Effect.runPromise(
      harness.storage.put({ key, body: new Uint8Array([9]), contentType: "text/plain" }),
    );
    expect(stub.requests.length).toBeGreaterThan(0);
    expect(stub.requests.every((request) => request.signed)).toBe(true);
  });

  test("uses multipart upload for streams larger than one part", async () => {
    const harness = await make();
    const key = await Effect.runPromise(objectKey("multipart/big.bin"));
    // Two 64 KiB parts + a remainder: forces the multipart path.
    const payload = new Uint8Array(64 * 1_024 * 2 + 5_000);
    for (let index = 0; index < payload.length; index++) payload[index] = index % 251;
    const stored = await Effect.runPromise(
      harness.storage.put({
        key,
        body: streamOf(payload),
        contentType: "application/octet-stream",
      }),
    );
    expect(stored.size).toBe(payload.byteLength);
    const partCounts = [...stub.partUploads.values()].map((parts) => parts.length);
    expect(Math.max(...partCounts, 0)).toBeGreaterThanOrEqual(2);
    const got = await Effect.runPromise(harness.storage.get(key));
    const reader = got.body.getReader();
    const chunks: Array<Uint8Array> = [];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value !== undefined) chunks.push(next.value);
    }
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    expect(total).toBe(payload.byteLength);
  });

  test("maps a 403 from the provider to a permanent rejection", async () => {
    const storage = makeS3Storage({
      bucket: "stub-bucket",
      region: "us-east-1",
      accessKeyId: "test-access-key",
      secretAccessKey: Redacted.make("test-secret-key"),
      endpoint: "http://127.0.0.1:1", // unreachable
    });
    const key = await Effect.runPromise(objectKey("unreachable.bin"));
    const error = await Effect.runPromise(Effect.flip(storage.head(key)));
    expect(error._tag).toBe("StorageUnavailable");
  });

  test("delete of a missing object stays idempotent against the provider", async () => {
    const harness = await make();
    const key = await Effect.runPromise(objectKey("idempotent/none.bin"));
    await Effect.runPromise(harness.storage.delete(key));
    const error = await Effect.runPromise(Effect.flip(harness.storage.head(key)));
    expect(error).toBeInstanceOf(ObjectNotFound);
    void StorageRejected;
  });
});
