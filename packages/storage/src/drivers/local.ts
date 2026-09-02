import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Effect, Schedule } from "effect";
import {
  ObjectNotFound,
  type StorageError,
  StorageUnavailable,
  StorageValidationError,
} from "../errors.js";
import { isValidKey, keyToString, type ObjectKey } from "../key.js";
import { type DispositionPolicy, dispositionPolicy, validContentType } from "../policy.js";
import {
  instrumented,
  type PutInput,
  retrieved,
  type Storage,
  type StoredObject,
} from "../storage.js";

export interface LocalStorageOptions {
  /** Root directory for all objects. Created on first use with mode 0700. */
  readonly rootDir: string;
  readonly policy?: DispositionPolicy;
}

const MODE_DIR = 0o700;
const MODE_FILE = 0o600;
const META_SUFFIX = ".meta.json";

interface MetaFile {
  readonly contentType: string;
  readonly disposition: "attachment" | "inline-if-isolated";
  readonly etag: string;
  readonly size: number;
  readonly lastModified: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

/** Streams `body` into `dest` chunk by chunk; returns bytes written. */
const pump = async (dest: string, body: ReadableStream<Uint8Array>): Promise<number> => {
  const writer = createWriteStream(dest, { mode: MODE_FILE });
  const reader = body.getReader();
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      if (chunk === undefined || chunk.byteLength === 0) continue;
      total += chunk.byteLength;
      if (!writer.write(chunk)) await once(writer, "drain");
    }
  } catch (cause) {
    writer.destroy();
    throw cause;
  }
  await new Promise<void>((resolve, reject) => {
    writer.end((error?: Error | null) =>
      error === null || error === undefined ? resolve() : reject(error),
    );
  });
  return total;
};

const isErrnoException = (cause: unknown, code: string): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause as { code: unknown }).code === code;

const errnoCode = (cause: unknown): string =>
  typeof cause === "object" && cause !== null && "code" in cause
    ? String((cause as { code: unknown }).code)
    : "error";

const retryUnavailable = <A, E extends StorageError>(
  effect: Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  effect.pipe(
    Effect.retry({
      schedule: Schedule.exponential("100 millis").pipe(
        Schedule.jittered,
        Schedule.intersect(Schedule.recurs(2)),
      ),
      while: (error): boolean => error._tag === "StorageUnavailable",
    }),
  );

/**
 * Local-filesystem driver. Objects live under `rootDir` at their key path,
 * with a `key.meta.json` sidecar carrying content type, disposition, and
 * metadata. Path safety is layered: keys are validated at brand time (no
 * `..`, no backslashes, restricted charset) and every resolved path is
 * re-checked to sit under the root before any filesystem call — so a bug in
 * one layer is not exploitable through the other.
 */
export const makeLocalStorage = (options: LocalStorageOptions): Storage => {
  const root = path.resolve(options.rootDir);
  const policy = options.policy ?? dispositionPolicy();

  /** Resolves a key inside the root; refuses anything that would escape it. */
  const safePath = (key: ObjectKey, suffix = ""): Effect.Effect<string, StorageError> =>
    Effect.try({
      try: () => {
        const resolved = path.resolve(root, `${keyToString(key)}${suffix}`);
        if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
          throw new Error("key escapes the storage root");
        }
        return resolved;
      },
      catch: () =>
        new StorageUnavailable({
          driver: "local",
          operation: "resolve-path",
          reason: "key-escapes-root",
        }),
    });

  const attempt = <A>(
    operation: string,
    key: ObjectKey | undefined,
    mapNotFound: boolean,
    run: (dataPath: string, metaPath: string) => Promise<A>,
  ): Effect.Effect<A, StorageError> =>
    Effect.gen(function* () {
      const keyForPath = key ?? ("unused" as ObjectKey);
      const dataPath = yield* safePath(keyForPath);
      const metaPath = yield* safePath(keyForPath, META_SUFFIX);
      return yield* Effect.tryPromise({
        try: () => run(dataPath, metaPath),
        catch: (cause): StorageError => {
          return mapNotFound && isErrnoException(cause, "ENOENT")
            ? new ObjectNotFound({ key: keyToString(keyForPath) })
            : new StorageUnavailable({
                driver: "local",
                operation,
                reason: `local-fs-${errnoCode(cause)}`,
              });
        },
      }).pipe(retryUnavailable);
    });

  const toStored = (key: ObjectKey, meta: MetaFile): StoredObject => ({
    key,
    contentType: meta.contentType,
    size: meta.size,
    etag: meta.etag,
    lastModified: new Date(meta.lastModified),
    disposition: meta.disposition,
    ...(meta.metadata === undefined ? {} : { metadata: meta.metadata }),
  });

  const storage: Storage = {
    put: (input: PutInput) =>
      Effect.gen(function* () {
        if (!validContentType(input.contentType)) {
          return yield* new StorageValidationError({
            field: "contentType",
            reason: "is not a valid media type",
          });
        }

        const written = yield* attempt("put", input.key, false, async (dataPath, metaPath) => {
          await fs.mkdir(path.dirname(dataPath), { recursive: true, mode: MODE_DIR });
          let written: number;
          if (input.body instanceof Uint8Array) {
            await fs.writeFile(dataPath, input.body, { mode: MODE_FILE });
            written = input.body.byteLength;
          } else {
            written = await pump(dataPath, input.body);
          }
          const meta: MetaFile = {
            contentType: input.contentType,
            disposition: input.disposition ?? "attachment",
            etag: randomUUID(),
            size: written,
            lastModified: new Date().toISOString(),
            ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
          };
          await fs.writeFile(metaPath, JSON.stringify(meta), { encoding: "utf8", mode: MODE_FILE });
          return meta;
        });
        return toStored(input.key, written);
      }),
    get: (key) =>
      Effect.gen(function* () {
        const meta = yield* attempt("get", key, true, async (dataPath, metaPath) => {
          const raw = await fs.readFile(metaPath, "utf8");
          await fs.stat(dataPath);
          return JSON.parse(raw) as MetaFile;
        });
        return retrieved(toStored(key, meta), Bun.file(yield* safePath(key)).stream(), policy);
      }),
    head: (key) =>
      Effect.gen(function* () {
        const meta = yield* attempt("head", key, true, async (dataPath, metaPath) => {
          const raw = await fs.readFile(metaPath, "utf8");
          const stat = await fs.stat(dataPath);
          return { parsed: JSON.parse(raw) as MetaFile, size: stat.size };
        });
        return toStored(key, { ...meta.parsed, size: meta.size });
      }),
    delete: (key) =>
      attempt("delete", key, false, async (dataPath, metaPath) => {
        await fs.rm(dataPath, { force: true });
        await fs.rm(metaPath, { force: true });
      }),
    list: (prefix) =>
      Effect.tryPromise({
        try: async () => {
          await fs.mkdir(root, { recursive: true, mode: MODE_DIR }).catch(() => undefined);
          const results: Array<StoredObject> = [];
          const walk = async (dir: string, relative: string): Promise<void> => {
            let entries: Array<import("node:fs").Dirent>;
            try {
              entries = await fs.readdir(dir, { withFileTypes: true });
            } catch (cause) {
              if (isErrnoException(cause, "ENOENT")) return;
              throw cause;
            }
            for (const entry of entries) {
              const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;
              if (entry.isDirectory()) {
                await walk(path.join(dir, entry.name), childRelative);
                continue;
              }
              if (!entry.name.endsWith(META_SUFFIX)) continue;
              const keyRaw = childRelative.slice(0, -META_SUFFIX.length);
              if (!keyRaw.startsWith(prefix) || !isValidKey(keyRaw)) continue;
              let raw: string;
              try {
                raw = await fs.readFile(path.join(dir, entry.name), "utf8");
              } catch {
                continue;
              }
              results.push(toStored(keyRaw as ObjectKey, JSON.parse(raw) as MetaFile));
            }
          };
          await walk(root, "");
          return results;
        },
        catch: (cause): StorageError =>
          new StorageUnavailable({
            driver: "local",
            operation: "list",
            reason: `local-fs-${errnoCode(cause)}`,
          }),
      }).pipe(retryUnavailable),
  };

  return instrumented("local", storage);
};
