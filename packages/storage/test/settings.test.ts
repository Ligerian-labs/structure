import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { load } from "@structure-ai/config";
import { Effect, Redacted } from "effect";
import { makeS3Storage, objectKey, storageFromSettings, storageSettings } from "../src/index.js";
import { sha256Hex, signRequest } from "../src/sigv4.js";

const endpoint = process.env.STORAGE_TEST_S3_ENDPOINT;
const accessKeyId = process.env.STORAGE_TEST_S3_ACCESS_KEY_ID ?? "minioadmin";
const secretAccessKey = process.env.STORAGE_TEST_S3_SECRET_ACCESS_KEY ?? "minioadmin";
const region = process.env.STORAGE_TEST_S3_REGION ?? "us-east-1";
const bucket = process.env.STORAGE_TEST_S3_BUCKET ?? "structure-storage-settings";

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
