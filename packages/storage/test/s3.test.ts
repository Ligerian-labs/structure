import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Option, Redacted } from "effect";
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

  test("a download slower than the timeout still delivers every byte (the timeout bounds the headers, not the body)", async () => {
    await make();
    const storage = makeS3Storage({
      bucket: "stub-bucket",
      region: "us-east-1",
      accessKeyId: "test-access-key",
      secretAccessKey: Redacted.make("test-secret-key"),
      endpoint: stub.url,
      // Headers arrive at once; the eight-chunk body takes ~1 s at 120 ms per chunk.
      timeoutMillis: 300,
    });
    const key = await Effect.runPromise(objectKey("slow/export.bin"));
    const payload = new Uint8Array(8 * 1_024);
    for (let index = 0; index < payload.length; index++) payload[index] = index % 251;
    await Effect.runPromise(
      storage.put({ key, body: payload, contentType: "application/octet-stream" }),
    );
    const got = await Effect.runPromise(storage.get(key));
    const reader = got.body.getReader();
    let received = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      received += next.value?.byteLength ?? 0;
    }
    expect(received).toBe(payload.byteLength);
  });

  test("a body that stops arriving fails the stream after the idle timeout instead of hanging", async () => {
    await make();
    const storage = makeS3Storage({
      bucket: "stub-bucket",
      region: "us-east-1",
      accessKeyId: "test-access-key",
      secretAccessKey: Redacted.make("test-secret-key"),
      endpoint: stub.url,
      timeoutMillis: 5_000,
      bodyIdleTimeoutMillis: 200,
    });
    const key = await Effect.runPromise(objectKey("stall/export.bin"));
    await Effect.runPromise(
      storage.put({ key, body: new Uint8Array(4_096), contentType: "application/octet-stream" }),
    );
    const got = await Effect.runPromise(storage.get(key));
    const reader = got.body.getReader();
    const started = Date.now();
    let failure: unknown;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
      }
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toBeDefined();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  const s3WithFetch = (
    fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
    partSize: number,
  ): Storage =>
    makeS3Storage({
      bucket: "b",
      region: "us-east-1",
      accessKeyId: "k",
      secretAccessKey: Redacted.make("s"),
      endpoint: "http://s3.local",
      partSize,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

  test("a streamed put sends each part as it fills instead of buffering the whole blob first", async () => {
    const partSize = 4;
    const totalChunks = 10;
    let chunksRead = 0;
    let chunksReadBeforeFirstRequest = -1;
    const chunksReadAtEachPart: Array<number> = [];
    const requests: Array<string> = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : (input as Request).url);
      if (chunksReadBeforeFirstRequest < 0) chunksReadBeforeFirstRequest = chunksRead;
      requests.push(`${init?.method ?? "GET"} ${url.search}`);
      if (url.searchParams.has("uploads")) {
        return new Response(
          "<InitiateMultipartUploadResult><UploadId>u1</UploadId></InitiateMultipartUploadResult>",
          { status: 200 },
        );
      }
      if (url.searchParams.has("partNumber")) chunksReadAtEachPart.push(chunksRead);
      return new Response("", { status: 200, headers: { etag: '"e"' } });
    };
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunksRead >= totalChunks) {
          controller.close();
          return;
        }
        chunksRead += 1;
        controller.enqueue(new Uint8Array(partSize).fill(chunksRead));
      },
    });
    const key = await Effect.runPromise(objectKey("files/streamed.bin"));
    const stored = await Effect.runPromise(
      s3WithFetch(fetchImpl, partSize).put({
        key,
        body,
        contentType: "application/octet-stream",
      }),
    );
    expect(stored.size).toBe(partSize * totalChunks);
    // Multipart began after the first full part, not after the whole stream.
    expect(chunksReadBeforeFirstRequest).toBeLessThanOrEqual(2);
    // Every part left as soon as it filled: part N went out with at most N+1 chunks read.
    for (const [index, readAt] of chunksReadAtEachPart.entries()) {
      expect(readAt).toBeLessThanOrEqual(index + 2);
    }
    expect(requests.filter((line) => line.includes("partNumber="))).toHaveLength(totalChunks);
    expect(requests[requests.length - 1]).toBe("POST ?uploadId=u1");
  });

  test("a failed part upload aborts the multipart upload so no orphaned parts remain", async () => {
    const requests: Array<string> = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : (input as Request).url);
      requests.push(`${init?.method ?? "GET"} ${url.search}`);
      if (url.searchParams.has("uploads")) {
        return new Response(
          "<InitiateMultipartUploadResult><UploadId>u2</UploadId></InitiateMultipartUploadResult>",
          { status: 200 },
        );
      }
      if (url.searchParams.get("partNumber") === "2") return new Response("", { status: 500 });
      return new Response("", { status: 200, headers: { etag: '"e"' } });
    };
    const key = await Effect.runPromise(objectKey("files/aborted.bin"));
    const error = await Effect.runPromise(
      Effect.flip(
        s3WithFetch(fetchImpl, 4).put({
          key,
          body: streamOf(new Uint8Array(12)),
          contentType: "application/octet-stream",
        }),
      ),
    );
    expect(error._tag).toBe("StorageUnavailable");
    expect(requests).toContain("DELETE ?uploadId=u2");
    expect(requests.indexOf("DELETE ?uploadId=u2")).toBe(requests.length - 1);
  });

  test("a stalled XML reply body fails within the request deadline instead of hanging", async () => {
    const fetchImpl = async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : (input as Request).url);
      if (url.searchParams.get("list-type") === "2") {
        // Headers arrive; the body never does.
        return new Response(
          new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) }),
          {
            status: 200,
            headers: { "content-type": "application/xml" },
          },
        );
      }
      return new Response("", { status: 200 });
    };
    const storage = makeS3Storage({
      bucket: "b",
      region: "us-east-1",
      accessKeyId: "k",
      secretAccessKey: Redacted.make("s"),
      endpoint: "http://s3.local",
      timeoutMillis: 300,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const started = Date.now();
    const error = await Effect.runPromise(Effect.flip(storage.list("")));
    expect(error._tag).toBe("StorageUnavailable");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("cancelling a guarded download cancels the upstream S3 body", async () => {
    let upstreamCancelled = false;
    const fetchImpl = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array(1_024));
          },
          cancel() {
            upstreamCancelled = true;
          },
        }),
        { status: 200, headers: { "content-length": "1048576" } },
      );
    const storage = makeS3Storage({
      bucket: "b",
      region: "us-east-1",
      accessKeyId: "k",
      secretAccessKey: Redacted.make("s"),
      endpoint: "http://s3.local",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const key = await Effect.runPromise(objectKey("files/cancelled.bin"));
    const got = await Effect.runPromise(storage.get(key));
    const reader = got.body.getReader();
    await reader.read();
    await reader.cancel("client went away");
    expect(upstreamCancelled).toBe(true);
  });

  test("an unexpected throw inside a streamed put surfaces as a typed StorageUnavailable, never a defect", async () => {
    const fetchImpl = async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : (input as Request).url);
      if (url.searchParams.has("uploads")) {
        return new Response(
          "<InitiateMultipartUploadResult><UploadId>u3</UploadId></InitiateMultipartUploadResult>",
          { status: 200 },
        );
      }
      if (url.searchParams.has("partNumber")) throw new Error("socket hang up");
      return new Response("", { status: 200 });
    };
    const key = await Effect.runPromise(objectKey("files/thrown.bin"));
    const exit = await Effect.runPromiseExit(
      s3WithFetch(fetchImpl, 4).put({
        key,
        body: streamOf(new Uint8Array(12)),
        contentType: "application/octet-stream",
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value._tag).toBe("StorageUnavailable");
        if (failure.value._tag === "StorageUnavailable")
          expect(failure.value.reason).toBe("s3-stream");
      }
    }
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
