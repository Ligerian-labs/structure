import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { load } from "@structure-ai/config";
import { Effect, Redacted } from "effect";
import {
  makeS3Storage,
  objectKey,
  StorageValidationError,
  storageFromSettings,
  storageSettings,
} from "../src/index.js";
import { s3Endpoint } from "../src/settings.js";
import { sha256Hex, signRequest } from "../src/sigv4.js";

const endpoint = process.env.STORAGE_TEST_S3_ENDPOINT;
const accessKeyId = process.env.STORAGE_TEST_S3_ACCESS_KEY_ID ?? "minioadmin";
const secretAccessKey = process.env.STORAGE_TEST_S3_SECRET_ACCESS_KEY ?? "minioadmin";
const region = process.env.STORAGE_TEST_S3_REGION ?? "us-east-1";
const bucket = process.env.STORAGE_TEST_S3_BUCKET ?? "structure-storage-settings";

describe("storage settings: the endpoint handed to the S3 driver", () => {
  test.each([
    ["http://minio:9000", "http://minio:9000"],
    ["http://minio:9000/", "http://minio:9000"],
    ["http://minio:9000///", "http://minio:9000"],
    ["HTTP://MinIO:9000/", "http://minio:9000"],
    ["https://s3.eu-west-1.amazonaws.com/", "https://s3.eu-west-1.amazonaws.com"],
    ["http://127.0.0.1:9270/", "http://127.0.0.1:9270"],
    ["http://gateway:8080/s3", "http://gateway:8080/s3"],
    ["http://gateway:8080/s3/", "http://gateway:8080/s3"],
  ])("%s is passed to the driver as %s", (configured, expected) => {
    expect(s3Endpoint(new URL(configured))).toBe(expected);
    expect(s3Endpoint(new URL(configured)).endsWith("/")).toBe(false);
  });

  test("a value with a non-web scheme passes through unchanged, never as the word null", () => {
    // `URL.origin` is the string "null" for such a value; the driver must
    // receive the address as configured and fail through its typed channel.
    expect(s3Endpoint(new URL("minio:9000"))).toBe("minio:9000");
    expect(s3Endpoint(new URL("s3://bucket/"))).toBe("s3://bucket");
  });

  test.each([
    ["a query string", "http://minio:9000/?x=1", "query"],
    ["a fragment", "http://minio:9000/#f", "fragment"],
  ])("%s on STORAGE_S3_ENDPOINT is refused at composition", async (_label, value, word) => {
    const settings = await Effect.runPromise(
      load(storageSettings, {
        overrides: {
          STORAGE_DRIVER: "s3",
          STORAGE_S3_BUCKET: "b",
          STORAGE_S3_REGION: "us-east-1",
          STORAGE_S3_ENDPOINT: value,
          STORAGE_S3_ACCESS_KEY_ID: "k",
          STORAGE_S3_SECRET_ACCESS_KEY: "s",
        },
      }),
    );
    const error = await Effect.runPromise(Effect.flip(storageFromSettings(settings)));
    expect(error).toBeInstanceOf(StorageValidationError);
    expect(error.field).toBe("STORAGE_S3_ENDPOINT");
    expect(error.reason).toContain(word);
  });
});

/**
 * The settings path against a real S3-compatible store (MinIO in CI-less
 * local runs): `STORAGE_TEST_S3_ENDPOINT=http://127.0.0.1:9270` with the
 * store's root credentials in `STORAGE_TEST_S3_ACCESS_KEY_ID` /
 * `STORAGE_TEST_S3_SECRET_ACCESS_KEY` (both default to `minioadmin`). The
 * bucket is created if missing; the objects written are deleted afterwards.
 * Skipped when the variable is absent, the way the pg suites skip without
 * `DATABASE_URL`.
 */
describe.skipIf(endpoint === undefined)(
  "storage settings against a real S3 store (needs STORAGE_TEST_S3_ENDPOINT)",
  () => {
    const base = (endpoint ?? "").replace(/\/+$/u, "");
    const credentials = {
      accessKeyId,
      secretAccessKey: Redacted.make(secretAccessKey),
      region,
      service: "s3",
    } as const;
    const written: Array<string> = [];

    beforeAll(async () => {
      const create = signRequest({
        credentials,
        method: "PUT",
        url: new URL(`${base}/${bucket}`),
        payloadHash: sha256Hex(""),
      });
      const response = await fetch(create.url, { method: "PUT", headers: create.headers });
      // 200 created, 409 already owned by this account: both leave a bucket.
      expect([200, 409]).toContain(response.status);
      await response.body?.cancel();
    });

    afterAll(async () => {
      for (const key of written) {
        const remove = signRequest({
          credentials,
          method: "DELETE",
          url: new URL(`${base}/${bucket}/${encodeURIComponent(key)}`),
          payloadHash: sha256Hex(""),
        });
        const response = await fetch(remove.url, { method: "DELETE", headers: remove.headers });
        await response.body?.cancel();
      }
    });

    const fromSettings = async (configuredEndpoint: string) => {
      const settings = await Effect.runPromise(
        load(storageSettings, {
          overrides: {
            STORAGE_DRIVER: "s3",
            STORAGE_S3_BUCKET: bucket,
            STORAGE_S3_REGION: region,
            STORAGE_S3_ENDPOINT: configuredEndpoint,
            STORAGE_S3_ACCESS_KEY_ID: accessKeyId,
            STORAGE_S3_SECRET_ACCESS_KEY: secretAccessKey,
          },
        }),
      );
      return Effect.runPromise(storageFromSettings(settings));
    };

    const roundTrip = async (storage: ReturnType<typeof makeS3Storage>, raw: string) => {
      const key = await Effect.runPromise(objectKey(raw));
      written.push(raw);
      const payload = new TextEncoder().encode(`hello from ${raw}`);
      const stored = await Effect.runPromise(
        storage.put({ key, body: payload, contentType: "text/plain" }),
      );
      expect(stored.size).toBe(payload.byteLength);
      const head = await Effect.runPromise(storage.head(key));
      expect(head.size).toBe(payload.byteLength);
      const got = await Effect.runPromise(storage.get(key));
      expect(got.contentType).toBe("text/plain");
      expect(await new Response(got.body).text()).toBe(`hello from ${raw}`);
    };

    test("STORAGE_S3_ENDPOINT as an operator writes it (no trailing slash): put, head, get", async () => {
      const storage = await fromSettings(base);
      await roundTrip(storage, `files/${crypto.randomUUID()}`);
    });

    test("STORAGE_S3_ENDPOINT with a trailing slash typed by the operator: put, head, get", async () => {
      const storage = await fromSettings(`${base}/`);
      await roundTrip(storage, `files/${crypto.randomUUID()}`);
    });

    test("readiness-style root listing answers through the settings path", async () => {
      const storage = await fromSettings(base);
      const listed = await Effect.runPromise(storage.list(""));
      expect(Array.isArray(listed)).toBe(true);
    });

    test("a path prefix on STORAGE_S3_ENDPOINT is kept: the object lands under the prefix, not at the store root", async () => {
      // A bucket of the store stands in for a gateway's path prefix: with
      // `STORAGE_S3_ENDPOINT=<store>/<prefix-bucket>/` and `STORAGE_S3_BUCKET=inner`,
      // the driver signs `/<prefix-bucket>/inner/<key>`, which the store files
      // in the prefix bucket under `inner/<key>`.
      const prefixBucket = `${bucket}-prefix`;
      const create = signRequest({
        credentials,
        method: "PUT",
        url: new URL(`${base}/${prefixBucket}`),
        payloadHash: sha256Hex(""),
      });
      const created = await fetch(create.url, { method: "PUT", headers: create.headers });
      expect([200, 409]).toContain(created.status);
      await created.body?.cancel();

      const raw = `files/${crypto.randomUUID()}`;
      const settings = await Effect.runPromise(
        load(storageSettings, {
          overrides: {
            STORAGE_DRIVER: "s3",
            STORAGE_S3_BUCKET: "inner",
            STORAGE_S3_REGION: region,
            STORAGE_S3_ENDPOINT: `${base}/${prefixBucket}/`,
            STORAGE_S3_ACCESS_KEY_ID: accessKeyId,
            STORAGE_S3_SECRET_ACCESS_KEY: secretAccessKey,
          },
        }),
      );
      const storage = await Effect.runPromise(storageFromSettings(settings));
      const key = await Effect.runPromise(objectKey(raw));
      await Effect.runPromise(
        storage.put({ key, body: new Uint8Array([1, 2]), contentType: "text/plain" }),
      );
      const head = await Effect.runPromise(storage.head(key));
      expect(head.size).toBe(2);

      // Seen from the store: the object is in the prefix bucket, under `inner/`.
      const list = signRequest({
        credentials,
        method: "GET",
        url: new URL(
          `${base}/${prefixBucket}?list-type=2&prefix=${encodeURIComponent(`inner/${raw}`)}`,
        ),
        payloadHash: sha256Hex(""),
      });
      const listed = await fetch(list.url, { method: "GET", headers: list.headers });
      expect(listed.status).toBe(200);
      expect(await listed.text()).toContain(`<Key>inner/${raw}</Key>`);
      // ...and nothing named `inner` exists at the store root.
      const root = signRequest({
        credentials,
        method: "HEAD",
        url: new URL(`${base}/inner/${encodeURIComponent(raw)}`),
        payloadHash: sha256Hex(""),
      });
      const atRoot = await fetch(root.url, { method: "HEAD", headers: root.headers });
      expect(atRoot.status).toBe(404);
      await atRoot.body?.cancel();

      const remove = signRequest({
        credentials,
        method: "DELETE",
        url: new URL(`${base}/${prefixBucket}/${encodeURIComponent(`inner/${raw}`)}`),
        payloadHash: sha256Hex(""),
      });
      const removed = await fetch(remove.url, { method: "DELETE", headers: remove.headers });
      await removed.body?.cancel();
    });

    test("control: the driver built by hand with a clean endpoint round-trips (the key encoding is fine)", async () => {
      const storage = makeS3Storage({
        bucket,
        region,
        accessKeyId,
        secretAccessKey: Redacted.make(secretAccessKey),
        endpoint: base,
      });
      await roundTrip(storage, `files/${crypto.randomUUID()}`);
    });
  },
);
