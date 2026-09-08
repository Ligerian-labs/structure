import { describe, expect, test } from "bun:test";
import { Effect, Redacted } from "effect";
import {
  makeS3Storage,
  objectKey,
  READINESS_PROBE_KEY,
  storageReadinessCheck,
} from "../src/index.js";
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

/** Records every URL the driver signs; answers as a store would. */
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

describe("S3 object path encoding (what is sent equals what is signed)", () => {
  test("a key with slashes is sent with its slashes as separators, in every operation", async () => {
    const transport = recordingFetch();
    const storage = makeS3Storage({
      bucket: "bucket",
      region: "us-east-1",
      ...credentials,
      endpoint: "http://store.local",
      keyPrefix: "tenant",
      partSize: 1_024,
      fetchImpl: transport.fetchImpl,
    });
    const key = await Effect.runPromise(objectKey("workspaces/ws-1/files/one.bin"));
    await Effect.runPromise(
      storage.put({ key, body: new Uint8Array([1, 2, 3]), contentType: "text/plain" }),
    );
    await Effect.runPromise(
      storage.put({ key, body: streamOf(new Uint8Array(3_000)), contentType: "text/plain" }),
    );
    await Effect.runPromise(storage.get(key));
    await Effect.runPromise(storage.head(key));
    await Effect.runPromise(storage.delete(key));
    await Effect.runPromise(storage.list("workspaces/ws-1/"));
    // put (bytes), initiate, 3 parts, complete, get, head, delete, list
    expect(transport.urls.length).toBe(10);
    for (const url of transport.urls.slice(0, 9)) {
      expect(pathOf(url)).toBe("/bucket/tenant/workspaces/ws-1/files/one.bin");
      expect(url).not.toContain("%2F");
    }
    // The list prefix is a query value: the query rule encodes the slash,
    // and every store canonicalises a query the same way, so it stays encoded.
    const list = new URL(transport.urls[9] ?? "");
    expect(list.pathname).toBe("/bucket");
    expect(list.search).toBe("?list-type=2&prefix=tenant%2Fworkspaces%2Fws-1%2F");
  });

  test("a key prefix is encoded segment by segment, RFC 3986, like the key", async () => {
    const transport = recordingFetch();
    const storage = makeS3Storage({
      bucket: "bucket",
      region: "us-east-1",
      ...credentials,
      endpoint: "http://store.local",
      // Every class the encoder must handle: a space (which `new URL` would
      // encode by itself, so it proves nothing alone), the characters
      // `encodeURIComponent` leaves bare but SigV4 percent-encodes (`!'()*`),
      // a `#` and a `?` (an unencoded one would swallow the key into a
      // fragment or a query), and a `%` (an unencoded one is a broken escape).
      keyPrefix: "acme corp/eu-west (#1)!/50%/q?a",
      fetchImpl: transport.fetchImpl,
    });
    const key = await Effect.runPromise(objectKey("files/one.bin"));
    await Effect.runPromise(storage.head(key));
    // Asserted on the whole URL, not on `pathname`: a swallowed key would
    // still leave a plausible pathname behind.
    expect(transport.urls[0]).toBe(
      "http://store.local/bucket/acme%20corp/eu-west%20%28%231%29%21/50%25/q%3Fa/files/one.bin",
    );
  });

  test("the readiness probe key is sent as /bucket/readiness/probe", async () => {
    const transport = recordingFetch();
    const storage = makeS3Storage({
      bucket: "blobs",
      region: "europe-west1",
      ...credentials,
      endpoint: "https://storage.googleapis.com",
      fetchImpl: transport.fetchImpl,
    });
    await Effect.runPromise(storage.head(READINESS_PROBE_KEY));
    expect(transport.urls[0]).toBe("https://storage.googleapis.com/blobs/readiness/probe");
  });
});

describe("S3 driver against a store that canonicalises the raw request path (GCS behaviour)", () => {
  let raw: S3StubServer;
  let decoded: S3StubServer;
  const rawStore = async (): Promise<S3StubServer> => {
    if (raw === undefined) raw = await startS3Stub({ canonicalPath: "raw" });
    return raw;
  };
  const decodedStore = async (): Promise<S3StubServer> => {
    if (decoded === undefined) decoded = await startS3Stub({ canonicalPath: "decoded" });
    return decoded;
  };

  const driver = (store: S3StubServer, partSize?: number) =>
    makeS3Storage({
      bucket: "stub-bucket",
      region: "europe-west1",
      ...credentials,
      endpoint: store.url,
      ...(partSize === undefined ? {} : { partSize }),
    });

  test("the stub models the difference: an encoded slash signed decoded verifies on MinIO/S3, not on GCS", async () => {
    // The reproduction the rehearsal ran against the real bucket, as a table:
    //   sign /B/readiness/probe , send /B/readiness%2Fprobe -> 403 on GCS (404 on MinIO)
    //   sign /B/readiness%2Fprobe, send /B/readiness%2Fprobe -> 404 everywhere
    //   sign /B/readiness/probe , send /B/readiness/probe   -> 404 everywhere
    const sign = (store: S3StubServer, path: string) =>
      signRequest({
        credentials: { ...credentials, region: "europe-west1", service: "s3" },
        method: "HEAD",
        url: new URL(`${store.url}${path}`),
        payloadHash: sha256Hex(""),
      });
    const send = async (store: S3StubServer, signedPath: string, sentPath: string) => {
      const signed = sign(store, signedPath);
      const response = await fetch(`${store.url}${sentPath}`, {
        method: "HEAD",
        headers: signed.headers,
      });
      return response.status;
    };
    const gcs = await rawStore();
    const minio = await decodedStore();
    // What the 0.1.0 driver did: the package's signer canonicalises
    // `readiness%2Fprobe` as `readiness/probe`, the wire carries `%2F`.
    expect(
      await send(minio, "/stub-bucket/readiness%2Fprobe", "/stub-bucket/readiness%2Fprobe"),
    ).toBe(404);
    expect(
      await send(gcs, "/stub-bucket/readiness%2Fprobe", "/stub-bucket/readiness%2Fprobe"),
    ).toBe(403);
    expect(gcs.unverified.at(-1)?.path).toBe("/stub-bucket/readiness%2Fprobe");
    // Consistent forms verify on both.
    expect(await send(minio, "/stub-bucket/readiness/probe", "/stub-bucket/readiness/probe")).toBe(
      404,
    );
    expect(await send(gcs, "/stub-bucket/readiness/probe", "/stub-bucket/readiness/probe")).toBe(
      404,
    );
  });

  test("a key with a slash round-trips: put, head, get, list, delete", async () => {
    const store = await rawStore();
    const storage = driver(store);
    const key = await Effect.runPromise(objectKey("workspaces/ws-1/files/report.pdf"));
    const before = store.unverified.length;
    const stored = await Effect.runPromise(
      storage.put({ key, body: new Uint8Array([7, 8, 9]), contentType: "application/pdf" }),
    );
    expect(stored.size).toBe(3);
    const head = await Effect.runPromise(storage.head(key));
    expect(head.size).toBe(3);
    const got = await Effect.runPromise(storage.get(key));
    expect(got.contentType).toBe("application/pdf");
    await got.body.cancel();
    const listed = await Effect.runPromise(storage.list("workspaces/ws-1/"));
    expect(listed.map((object) => String(object.key))).toContain(
      "workspaces/ws-1/files/report.pdf",
    );
    await Effect.runPromise(storage.delete(key));
    expect(await Effect.runPromise(Effect.flip(storage.head(key)))).toHaveProperty(
      "_tag",
      "ObjectNotFound",
    );
    expect(store.unverified.length).toBe(before);
    expect(store.objects.has("workspaces/ws-1/files/report.pdf")).toBe(false);
  });

  test("a streamed put larger than one part completes its multipart upload under a slashed key", async () => {
    const store = await rawStore();
    const storage = driver(store, 64 * 1_024);
    const key = await Effect.runPromise(objectKey("exports/2026/09/big.bin"));
    const payload = new Uint8Array(64 * 1_024 * 2 + 5_000);
    for (let index = 0; index < payload.length; index++) payload[index] = index % 251;
    const before = store.unverified.length;
    const stored = await Effect.runPromise(
      storage.put({ key, body: streamOf(payload), contentType: "application/octet-stream" }),
    );
    expect(stored.size).toBe(payload.byteLength);
    expect(store.objects.get("exports/2026/09/big.bin")?.bytes.byteLength).toBe(payload.byteLength);
    expect(store.unverified.length).toBe(before);
  });

  test("a key prefix with reserved characters verifies and lands under its literal name", async () => {
    const store = await rawStore();
    const storage = makeS3Storage({
      bucket: "stub-bucket",
      region: "europe-west1",
      ...credentials,
      endpoint: store.url,
      keyPrefix: "acme corp/eu-west (#1)!/50%",
    });
    const key = await Effect.runPromise(objectKey("files/two.bin"));
    const before = store.unverified.length;
    await Effect.runPromise(
      storage.put({ key, body: new Uint8Array([2]), contentType: "text/plain" }),
    );
    expect(store.objects.has("acme corp/eu-west (#1)!/50%/files/two.bin")).toBe(true);
    const head = await Effect.runPromise(storage.head(key));
    expect(head.size).toBe(1);
    // The list prefix travels as a query value; the stub's raw mode must
    // canonicalise the query the way SigV4 does (`!()` encoded) or the
    // signature of a prefix with those characters never verifies.
    const listed = await Effect.runPromise(storage.list("files/"));
    expect(listed.map((object) => String(object.key))).toContain("files/two.bin");
    expect(store.unverified.length).toBe(before);
  });

  test("the readiness check reports ready against such a store", async () => {
    const store = await rawStore();
    const ready = await Effect.runPromise(storageReadinessCheck(driver(store)).run);
    expect(ready).toBe(true);
    expect(store.requests.at(-1)?.path).toBe("/stub-bucket/readiness/probe");
  });

  test("the same driver still round-trips against a store that decodes first (MinIO/S3 unchanged)", async () => {
    const store = await decodedStore();
    const storage = driver(store);
    const key = await Effect.runPromise(objectKey("workspaces/ws-2/files/note.txt"));
    const before = store.unverified.length;
    await Effect.runPromise(
      storage.put({ key, body: new Uint8Array([1]), contentType: "text/plain" }),
    );
    const head = await Effect.runPromise(storage.head(key));
    expect(head.size).toBe(1);
    // The object lands under the decoded key: an object written by 0.1.0
    // (sent as `%2F`, stored decoded) is found by the fixed driver.
    expect(store.objects.has("workspaces/ws-2/files/note.txt")).toBe(true);
    expect(store.unverified.length).toBe(before);
  });
});
