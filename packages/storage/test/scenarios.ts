import { expect, test } from "bun:test";
import { Effect } from "effect";
import {
  type ObjectKey,
  ObjectNotFound,
  objectKey,
  type Storage,
  StorageRejected,
  StorageUnavailable,
} from "../src/index.js";

export interface StorageHarness {
  readonly storage: Storage;
  /** Driver-specific key escaping probe: passes a forged key straight to the driver. */
  readonly probeEscape?: (forgedKey: string) => Promise<unknown>;
  readonly close: () => Promise<void>;
}

export type MakeStorage = () => Promise<StorageHarness>;

export const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

const bytes = (length: number, fill = 0x61): Uint8Array => {
  const out = new Uint8Array(length);
  for (let index = 0; index < length; index++) out[index] = (fill + index) % 251;
  return out;
};

const collect = async (body: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
  const reader = body.getReader();
  const chunks: Array<Uint8Array> = [];
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    if (next.value !== undefined) chunks.push(next.value);
  }
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};

export const streamOf = (data: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });

export const registerStorageScenarios = (name: string, make: MakeStorage): void => {
  test(`${name}: put/get/head round-trip fixed bytes with metadata`, async () => {
    const harness = await make();
    try {
      const key = await run(objectKey("objects/round-trip.bin"));
      const stored = await run(
        harness.storage.put({
          key,
          body: bytes(2048),
          contentType: "application/octet-stream",
          disposition: "attachment",
          metadata: { owner: "user-1", kind: "export" },
        }),
      );
      expect(stored.size).toBe(2048);
      expect(stored.metadata).toEqual({ owner: "user-1", kind: "export" });

      const head = await run(harness.storage.head(key));
      expect(head.size).toBe(2048);
      expect(head.contentType).toBe("application/octet-stream");

      const got = await run(harness.storage.get(key));
      expect(got.servingHeaders["x-content-type-options"]).toBe("nosniff");
      expect(got.servingHeaders["content-disposition"]).toContain("attachment");
      expect((await collect(got.body)).byteLength).toBe(2048);
    } finally {
      await harness.close();
    }
  });

  test(`${name}: streams large blobs without buffering them whole`, async () => {
    const harness = await make();
    try {
      const key = await run(objectKey("objects/streamed.bin"));
      const payload = bytes(2 * 1_024 * 1_024);
      const stored = await run(
        harness.storage.put({
          key,
          body: streamOf(payload),
          contentType: "application/octet-stream",
        }),
      );
      expect(stored.size).toBe(payload.byteLength);
      const got = await run(harness.storage.get(key));
      expect(await collect(got.body)).toEqual(payload);
    } finally {
      await harness.close();
    }
  });

  test(`${name}: get/head of a missing object fails with ObjectNotFound`, async () => {
    const harness = await make();
    try {
      const key = await run(objectKey("objects/missing.bin"));
      const gotError = await Effect.runPromise(Effect.flip(harness.storage.get(key)));
      expect(gotError).toBeInstanceOf(ObjectNotFound);
      const headError = await Effect.runPromise(Effect.flip(harness.storage.head(key)));
      expect(headError).toBeInstanceOf(ObjectNotFound);
    } finally {
      await harness.close();
    }
  });

  test(`${name}: delete is idempotent`, async () => {
    const harness = await make();
    try {
      const key = await run(objectKey("objects/deleted.bin"));
      await run(
        harness.storage.put({ key, body: bytes(16), contentType: "application/octet-stream" }),
      );
      await run(harness.storage.delete(key));
      await run(harness.storage.delete(key));
      const error = await Effect.runPromise(Effect.flip(harness.storage.head(key)));
      expect(error).toBeInstanceOf(ObjectNotFound);
    } finally {
      await harness.close();
    }
  });

  test(`${name}: list filters by prefix`, async () => {
    const harness = await make();
    try {
      const a = await run(objectKey("listing/a.bin"));
      const b = await run(objectKey("listing/b.bin"));
      const other = await run(objectKey("objects/other.bin"));
      for (const key of [a, b, other]) {
        await run(
          harness.storage.put({ key, body: bytes(8), contentType: "application/octet-stream" }),
        );
      }
      const listed = await run(harness.storage.list("listing/"));
      expect(listed.map((object) => object.key as string).sort()).toEqual([
        "listing/a.bin",
        "listing/b.bin",
      ]);
    } finally {
      await harness.close();
    }
  });

  test(`${name}: disposition policy serves attachment by default and inline only for allowlisted types`, async () => {
    const harness = await make();
    try {
      const attachment = await run(objectKey("objects/avatar-1.bin"));
      const inline = await run(objectKey("objects/avatar-2.bin"));
      const riskyInline = await run(objectKey("objects/page.bin"));
      await run(
        harness.storage.put({
          key: attachment,
          body: bytes(8),
          contentType: "image/png",
        }),
      );
      await run(
        harness.storage.put({
          key: inline,
          body: bytes(8),
          contentType: "image/png",
          disposition: "inline-if-isolated",
        }),
      );
      await run(
        harness.storage.put({
          key: riskyInline,
          body: bytes(8),
          contentType: "text/html",
          disposition: "inline-if-isolated",
        }),
      );
      const served = await run(harness.storage.get(attachment));
      expect(served.servingHeaders["content-disposition"]).toContain("attachment");
      const servedInline = await run(harness.storage.get(inline));
      expect(servedInline.servingHeaders["content-disposition"]).toBe("inline");
      const servedRisky = await run(harness.storage.get(riskyInline));
      expect(servedRisky.servingHeaders["content-disposition"]).toContain("attachment");
      expect(servedRisky.servingHeaders["x-content-type-options"]).toBe("nosniff");
    } finally {
      await harness.close();
    }
  });

  test(`${name}: rejects invalid content types at the port`, async () => {
    const harness = await make();
    try {
      const key = await run(objectKey("objects/bad.bin"));
      const error = await Effect.runPromise(
        Effect.flip(
          harness.storage.put({
            key,
            body: bytes(4),
            contentType: "bad\r\ncontent-type: x",
          }),
        ),
      );
      expect(error._tag).toBe("StorageValidationError");
    } finally {
      await harness.close();
    }
  });

  test(`${name}: forged keys that escape the root are refused`, async () => {
    const harness = await make();
    try {
      const forged = "../outside" as ObjectKey;
      const outcome = await Effect.runPromiseExit(harness.storage.get(forged));
      const failure =
        outcome._tag === "Failure"
          ? ((outcome.cause as { error?: { _tag?: string } }).error ?? undefined)
          : undefined;
      expect(["ObjectNotFound", "StorageUnavailable", "StorageRejected"]).toContain(
        failure?._tag ?? "none",
      );
      if (outcome._tag === "Failure") {
        // The escape must never succeed silently with real content.
        expect(failure?._tag).not.toBe(undefined);
      }
    } finally {
      await harness.close();
    }
  });
};

export { StorageRejected, StorageUnavailable };
