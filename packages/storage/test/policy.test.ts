import { describe, expect, test } from "bun:test";
import { load } from "@structure-ai/config";
import { Effect, Option, Redacted } from "effect";
import {
  dispositionPolicy,
  objectKey,
  servingHeaders,
  storageFromSettings,
  storageSettings,
  validContentType,
} from "../src/index.js";

describe("disposition policy", () => {
  test("serves attachment by default with nosniff always set", () => {
    const headers = servingHeaders({
      key: "objects/x.bin" as never,
      contentType: "image/png",
      disposition: "attachment",
    });
    expect(headers["content-disposition"]).toContain("attachment");
    expect(headers["x-content-type-options"]).toBe("nosniff");
  });

  test("inline only for allowlisted content types, never html/svg", () => {
    const policy = dispositionPolicy();
    const inline = servingHeaders(
      {
        key: "objects/x.png" as never,
        contentType: "image/png",
        disposition: "inline-if-isolated",
      },
      policy,
    );
    expect(inline["content-disposition"]).toBe("inline");
    const html = servingHeaders(
      {
        key: "objects/x.html" as never,
        contentType: "text/html",
        disposition: "inline-if-isolated",
      },
      policy,
    );
    expect(html["content-disposition"]).toContain("attachment");
    const svg = servingHeaders(
      {
        key: "objects/x.svg" as never,
        contentType: "image/svg+xml",
        disposition: "inline-if-isolated",
      },
      policy,
    );
    expect(svg["content-disposition"]).toContain("attachment");
  });

  test("sanitizes filenames derived from keys", () => {
    const headers = servingHeaders({
      key: "objects/report.final.pdf" as never,
      contentType: "application/octet-stream",
      disposition: "attachment",
    });
    expect(headers["content-disposition"]).toContain('filename="report.final.pdf"');
  });

  test("validates content types against injection", () => {
    expect(validContentType("application/pdf")).toBe(true);
    expect(validContentType("text/plain; charset=utf-8")).toBe(true);
    expect(validContentType("bad\r\ninjection")).toBe(false);
    expect(validContentType("")).toBe(false);
  });
});

describe("storage settings", () => {
  test("loads s3 settings with the secret redacted", async () => {
    const settings = await Effect.runPromise(
      load(storageSettings, {
        overrides: {
          STORAGE_DRIVER: "s3",
          STORAGE_S3_BUCKET: "uploads",
          STORAGE_S3_REGION: "eu-west-1",
          STORAGE_S3_ACCESS_KEY_ID: "AKIA-test",
          STORAGE_S3_SECRET_ACCESS_KEY: "shhh",
        },
      }),
    );
    expect(settings.driver).toBe("s3");
    expect(String(settings.s3SecretAccessKey)).not.toContain("shhh");
    expect(settings.s3SecretAccessKey).toEqual(Option.some(Redacted.make("shhh")));
  });

  test("rejects local selection without a data dir", async () => {
    const settings = await Effect.runPromise(
      load(storageSettings, { overrides: { STORAGE_DRIVER: "local" } }),
    );
    const error = await Effect.runPromise(Effect.flip(storageFromSettings(settings)));
    expect(error._tag).toBe("StorageValidationError");
  });

  test("rejects s3 selection without credentials", async () => {
    const settings = await Effect.runPromise(
      load(storageSettings, { overrides: { STORAGE_DRIVER: "s3", STORAGE_S3_BUCKET: "b" } }),
    );
    const error = await Effect.runPromise(Effect.flip(storageFromSettings(settings)));
    expect(error._tag).toBe("StorageValidationError");
  });

  test("builds a working local driver from settings", async () => {
    const settings = await Effect.runPromise(
      load(storageSettings, {
        overrides: { STORAGE_DRIVER: "local", STORAGE_DATA_DIR: "/tmp/structure-storage-settings" },
      }),
    );
    const storage = await Effect.runPromise(storageFromSettings(settings));
    const key = await Effect.runPromise(objectKey("settings/probe.bin"));
    await Effect.runPromise(
      storage.put({ key, body: new Uint8Array([1]), contentType: "text/plain" }),
    );
    const head = await Effect.runPromise(storage.head(key));
    expect(head.size).toBe(1);
  });
});
