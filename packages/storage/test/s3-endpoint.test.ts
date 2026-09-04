import { describe, expect, test } from "bun:test";
import { load } from "@structure-ai/config";
import { Effect, Redacted } from "effect";
import { makeS3Storage, objectKey, storageFromSettings, storageSettings } from "../src/index.js";
import { sha256Hex, signRequest } from "../src/sigv4.js";
import {
  type S3StubServer,
  STUB_ACCESS_KEY_ID,
  STUB_SECRET_ACCESS_KEY,
  startS3Stub,
} from "./s3.stub.js";
import { streamOf } from "./scenarios.js";

const credentials = {
  accessKeyId: STUB_ACCESS_KEY_ID,
  secretAccessKey: Redacted.make(STUB_SECRET_ACCESS_KEY),
} as const;

/**
 * A transport that answers every request as a store would (200, an
 * `UploadId` for a multipart initiate) and records the URL it was given,
 * so the signed path can be inspected without any server.
 */
const recordingFetch = (): { readonly urls: Array<string>; readonly fetchImpl: typeof fetch } => {
  const urls: Array<string> = [];
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    return new URL(url).searchParams.has("uploads")
      ? new Response(
          "<InitiateMultipartUploadResult><UploadId>u1</UploadId></InitiateMultipartUploadResult>",
          { status: 200 },
        )
      : new Response("", { status: 200, headers: { "content-length": "0" } });
  };
  return { urls, fetchImpl: fetchImpl as unknown as typeof fetch };
};

const pathOf = (url: string): string => new URL(url).pathname;

/** Drives every operation the driver has, multipart included, through one endpoint. */
const exerciseEveryOperation = async (endpoint: string | undefined): Promise<Array<string>> => {
  const transport = recordingFetch();
  const storage = makeS3Storage({
    bucket: "bucket",
    region: "us-east-1",
    ...credentials,
    ...(endpoint === undefined ? {} : { endpoint }),
    keyPrefix: "tenant",
    partSize: 1_024,
    fetchImpl: transport.fetchImpl,
  });
  const key = await Effect.runPromise(objectKey("files/one.bin"));
  await Effect.runPromise(
    storage.put({ key, body: new Uint8Array([1, 2, 3]), contentType: "text/plain" }),
  );
  await Effect.runPromise(
    storage.put({ key, body: streamOf(new Uint8Array(3_000)), contentType: "text/plain" }),
  );
  await Effect.runPromise(storage.get(key));
  await Effect.runPromise(storage.head(key));
  await Effect.runPromise(storage.delete(key));
  await Effect.runPromise(storage.list("files/"));
  return transport.urls;
};

describe("S3 endpoint normalisation", () => {
  test.each([
    ["one trailing slash", "http://minio:9000/"],
    ["several trailing slashes", "http://minio:9000///"],
    ["a port and a trailing slash", "http://127.0.0.1:9270/"],
  ])("the signed path never doubles a slash for an endpoint with %s", async (_label, endpoint) => {
    const urls = await exerciseEveryOperation(endpoint);
    // put (bytes), initiate, 3 parts, complete, get, head, delete, list
    expect(urls.length).toBe(10);
    for (const url of urls) {
      expect(pathOf(url)).not.toContain("//");
      expect(pathOf(url).startsWith("/bucket")).toBe(true);
      expect(url.startsWith("http://")).toBe(true);
    }
    expect(pathOf(urls[0] ?? "")).toBe("/bucket/tenant/files%2Fone.bin");
    expect(pathOf(urls[9] ?? "")).toBe("/bucket");
  });

  test("an endpoint without a trailing slash, and the AWS default, are unchanged", async () => {
    const clean = await exerciseEveryOperation("http://minio:9000");
    expect(clean.every((url) => url.startsWith("http://minio:9000/bucket"))).toBe(true);
    const aws = await exerciseEveryOperation(undefined);
    expect(aws.every((url) => url.startsWith("https://s3.us-east-1.amazonaws.com/bucket"))).toBe(
      true,
    );
  });
});

describe("S3 endpoint normalisation (against the signature-verifying stub)", () => {
  let stub: S3StubServer;
  const stubServer = async (): Promise<S3StubServer> => {
    if (stub === undefined) stub = await startS3Stub();
    return stub;
  };

  const roundTrip = async (
    storage: ReturnType<typeof makeS3Storage>,
    raw: string,
  ): Promise<void> => {
    const key = await Effect.runPromise(objectKey(raw));
    const stored = await Effect.runPromise(
      storage.put({ key, body: new Uint8Array([7, 8, 9]), contentType: "text/plain" }),
    );
    expect(stored.size).toBe(3);
    const head = await Effect.runPromise(storage.head(key));
    expect(head.size).toBe(3);
    const got = await Effect.runPromise(storage.get(key));
    expect(got.contentType).toBe("text/plain");
    await got.body.cancel();
  };

  test("the stub refuses a signature computed over a doubled-slash path, like MinIO", async () => {
    const server = await stubServer();
    const sign = (path: string) =>
      signRequest({
        credentials: { ...credentials, region: "us-east-1", service: "s3" },
        method: "PUT",
        url: new URL(`${server.url}${path}`),
        headers: { "content-type": "text/plain" },
        payloadHash: sha256Hex("x"),
        body: "x",
      });
    const doubled = sign("//stub-bucket/probe%2Fdoubled.txt");
    const rejected = await fetch(doubled.url, {
      method: "PUT",
      headers: doubled.headers,
      body: "x",
    });
    expect(rejected.status).toBe(403);
    const body = await rejected.text();
    expect(body).toContain("<Code>SignatureDoesNotMatch</Code>");
    expect(body).toContain("<Resource>/stub-bucket/probe/doubled.txt</Resource>");
    const single = sign("/stub-bucket/probe%2Fsingle.txt");
    const accepted = await fetch(single.url, { method: "PUT", headers: single.headers, body: "x" });
    expect(accepted.status).toBe(200);
    // The signature covered `//stub-bucket/...`; the wire may carry the
    // leading slashes collapsed already (Bun's fetch does), the store
    // canonicalises either way, and the two never agree.
    expect(server.unverified.at(-1)?.path).toMatch(/^\/+stub-bucket\/probe%2Fdoubled\.txt$/u);
    expect(server.requests.at(-1)?.path).toBe("/stub-bucket/probe%2Fsingle.txt");
  });

  test("a driver built by hand with a trailing-slash endpoint round-trips", async () => {
    const server = await stubServer();
    const storage = makeS3Storage({
      bucket: "stub-bucket",
      region: "us-east-1",
      ...credentials,
      endpoint: `${server.url}/`,
    });
    await roundTrip(storage, "files/by-hand.txt");
  });

  test("a driver built through storageFromSettings with STORAGE_S3_ENDPOINT set round-trips", async () => {
    const server = await stubServer();
    const settings = await Effect.runPromise(
      load(storageSettings, {
        overrides: {
          STORAGE_DRIVER: "s3",
          STORAGE_S3_BUCKET: "stub-bucket",
          STORAGE_S3_REGION: "us-east-1",
          STORAGE_S3_ENDPOINT: server.url,
          STORAGE_S3_ACCESS_KEY_ID: STUB_ACCESS_KEY_ID,
          STORAGE_S3_SECRET_ACCESS_KEY: STUB_SECRET_ACCESS_KEY,
        },
      }),
    );
    const storage = await Effect.runPromise(storageFromSettings(settings));
    const before = server.requests.length;
    const rejectedBefore = server.unverified.length;
    await roundTrip(storage, "files/from-settings.txt");
    const mine = server.requests.slice(before);
    expect(mine.length).toBe(3);
    expect(mine.every((request) => request.path.startsWith("/stub-bucket/"))).toBe(true);
    expect(server.unverified.length).toBe(rejectedBefore);
  });
});
