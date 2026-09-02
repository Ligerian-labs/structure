import { Metrics } from "@structure-ai/observability";
import { Effect } from "effect";
import type { StorageError } from "./errors.js";
import type { ObjectKey } from "./key.js";
import { type Disposition, type DispositionPolicy, servingHeaders } from "./policy.js";

/** Fixed bytes or a streamed body; drivers never buffer a stream whole. */
export type ObjectBody = Uint8Array | ReadableStream<Uint8Array>;

export interface PutInput {
  readonly key: ObjectKey;
  readonly body: ObjectBody;
  readonly contentType: string;
  /** Defaults to `attachment` — user content is never rendered inline by accident. */
  readonly disposition?: Disposition;
  /** Small, string-only object metadata; never logged. */
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface StoredObject {
  readonly key: ObjectKey;
  readonly contentType: string;
  readonly size: number;
  readonly etag?: string;
  readonly lastModified?: Date;
  readonly disposition: Disposition;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface RetrievedObject extends StoredObject {
  readonly body: ReadableStream<Uint8Array>;
  /** Serving headers for this object — the disposition policy enforced here. */
  readonly servingHeaders: Readonly<Record<string, string>>;
}

export type StorageOperation = "put" | "get" | "head" | "delete" | "list";

/**
 * Blob storage port. Drivers are responsible for: streaming bodies without
 * full buffering, and classifying failures (`ObjectNotFound` permanent,
 * network/5xx transient with bounded retry). Serving headers come from
 * {@link retrieved} so the disposition policy is enforced at this port,
 * whichever driver is underneath.
 */
export interface Storage {
  readonly put: (input: PutInput) => Effect.Effect<StoredObject, StorageError>;
  readonly get: (key: ObjectKey) => Effect.Effect<RetrievedObject, StorageError>;
  readonly head: (key: ObjectKey) => Effect.Effect<StoredObject, StorageError>;
  /** Idempotent: deleting a missing object succeeds. */
  readonly delete: (key: ObjectKey) => Effect.Effect<void, StorageError>;
  readonly list: (prefix: string) => Effect.Effect<ReadonlyArray<StoredObject>, StorageError>;
}

/** Builds a {@link RetrievedObject}: stored metadata + body + enforced serving headers. */
export const retrieved = (
  object: StoredObject,
  body: ReadableStream<Uint8Array>,
  policy: DispositionPolicy,
): RetrievedObject => ({
  ...object,
  body,
  servingHeaders: servingHeaders(object, policy),
});

/**
 * Wraps a driver with per-operation boundary metrics (traffic, errors,
 * latency) and structured operation logs carrying the key — never body or
 * metadata content. `ObjectNotFound` is the caller's answer, not a driver
 * failure, so it is neither counted nor logged as an error.
 */
export const instrumented = (driver: string, storage: Storage): Storage => {
  const wrap =
    <A>(
      operation: StorageOperation,
      key: string | undefined,
      describe: (result: A) => Record<string, unknown>,
    ) =>
    (effect: Effect.Effect<A, StorageError>): Effect.Effect<A, StorageError> =>
      effect.pipe(
        Metrics.track(`storage_${driver}_${operation}`),
        Effect.tap((result) =>
          Effect.logInfo("storage operation").pipe(
            Effect.annotateLogs({
              storageDriver: driver,
              storageOperation: operation,
              ...(key !== undefined && { storageKey: key }),
              ...describe(result),
            }),
            Effect.asVoid,
          ),
        ),
        Effect.tapError((error) =>
          error._tag === "ObjectNotFound"
            ? Effect.void
            : Effect.logWarning("storage operation failed").pipe(
                Effect.annotateLogs({
                  storageDriver: driver,
                  storageOperation: operation,
                  ...(key !== undefined && { storageKey: key }),
                  storageError: error._tag,
                  ...(error._tag === "StorageUnavailable" && { storageReason: error.reason }),
                }),
                Effect.asVoid,
              ),
        ),
      );

  return {
    put: (input) =>
      storage.put(input).pipe(
        wrap<StoredObject>("put", input.key, (object) => ({
          storageSize: object.size,
          storageDisposition: object.disposition,
        })),
      ),
    get: (key) => storage.get(key).pipe(wrap<RetrievedObject>("get", key, () => ({}))),
    head: (key) =>
      storage
        .head(key)
        .pipe(wrap<StoredObject>("head", key, (object) => ({ storageSize: object.size }))),
    delete: (key) => storage.delete(key).pipe(wrap<void>("delete", key, () => ({}))),
    list: (prefix) =>
      storage.list(prefix).pipe(
        wrap<ReadonlyArray<StoredObject>>("list", undefined, (objects) => ({
          storagePrefix: prefix,
          storageResults: objects.length,
        })),
      ),
  };
};
