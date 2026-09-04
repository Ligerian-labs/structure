import { Effect, type Redacted } from "effect";
import {
  ObjectNotFound,
  type StorageError,
  StorageRejected,
  StorageUnavailable,
  StorageValidationError,
} from "../errors.js";
import { keyToString, type ObjectKey } from "../key.js";
import { type DispositionPolicy, dispositionPolicy, validContentType } from "../policy.js";
import { type RequestBody, sha256Hex, signRequest } from "../sigv4.js";
import {
  instrumented,
  type PutInput,
  retrieved,
  type Storage,
  type StoredObject,
} from "../storage.js";

export interface S3StorageOptions {
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: Redacted.Redacted<string>;
  /**
   * Path-style endpoint base the driver appends `/<bucket>/<key>` to.
   * Trailing slashes are stripped at construction, so `http://minio:9000/`
   * signs the same `/bucket/key` path as `http://minio:9000` (a doubled
   * slash is rejected by every S3-compatible store as
   * `SignatureDoesNotMatch`); a path prefix is kept as given. A query or
   * fragment is not supported. Default: `https://s3.<region>.amazonaws.com`.
   */
  readonly endpoint?: string;
  /** Optional key prefix inside the bucket (multi-tenant namespacing). */
  readonly keyPrefix?: string;
  /** Multipart part size / buffering ceiling. Default 8 MiB. */
  readonly partSize?: number;
  readonly policy?: DispositionPolicy;
  /** Injectable transport for tests. Defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /**
   * Deadline for one request up to its response headers (the upload of a
   * fixed body or one multipart part included). Default 30 s. A streamed
   * download body is never bounded by this: see `bodyIdleTimeoutMillis`.
   */
  readonly timeoutMillis?: number;
  /**
   * Idle timeout between two chunks of a downloaded body: the stream fails
   * when no byte arrives for this long, however long the whole transfer
   * takes. Default: `timeoutMillis`.
   */
  readonly bodyIdleTimeoutMillis?: number;
  readonly now?: () => Date;
}

const DEFAULT_PART_SIZE = 8 * 1_024 * 1_024;

const metadataHeaderName = (name: string): string | undefined => {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/gu, "-");
  return cleaned.length === 0 || cleaned.length > 64 ? undefined : cleaned;
};

/**
 * S3 driver (path-style, SigV4-signed, no SDK dependency). Fixed bytes go
 * out as one signed PUT. Streams are read sequentially into one bounded
 * `partSize` buffer: a stream that ends within one part is sent as a single
 * PUT, larger ones initiate a multipart upload on the first full part and
 * send each part as it fills — memory stays capped at one part plus one
 * chunk, never the whole blob; a failure after initiate aborts the upload
 * so no orphaned parts accumulate in the bucket.
 */
export const makeS3Storage = (options: S3StorageOptions): Storage => {
  const endpoint = (options.endpoint ?? `https://s3.${options.region}.amazonaws.com`).replace(
    /\/+$/u,
    "",
  );
  const partSize = options.partSize ?? DEFAULT_PART_SIZE;
  const policy = options.policy ?? dispositionPolicy();
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = options.timeoutMillis ?? 30_000;
  const bodyIdleTimeout = options.bodyIdleTimeoutMillis ?? timeout;

  const credentials = {
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    region: options.region,
    service: "s3",
  } as const;

  const objectUrl = (key: ObjectKey, query?: string): URL => {
    const prefix = options.keyPrefix === undefined ? "" : `${options.keyPrefix}/`;
    const base = `${endpoint}/${options.bucket}/${prefix}${encodeURIComponent(keyToString(key))}`;
    return new URL(query === undefined ? base : `${base}?${query}`);
  };

  const doFetch = async (input: {
    readonly method: string;
    readonly url: URL;
    readonly headers?: Readonly<Record<string, string>>;
    readonly payloadHash?: string;
    readonly body?: RequestBody;
  }): Promise<Response> => {
    const signed = signRequest({
      credentials,
      method: input.method,
      url: input.url,
      ...(input.headers === undefined ? {} : { headers: input.headers }),
      payloadHash: input.payloadHash ?? sha256Hex(""),
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(options.now === undefined ? {} : { now: options.now() }),
    });
    // The deadline covers the request and the response headers only: it is
    // disarmed once `fetch` resolves, so a body streamed to a slow consumer
    // is never cut by a wall-clock timer (the idle guard below bounds it).
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new DOMException("s3 request timed out", "TimeoutError")),
      timeout,
    );
    try {
      return await fetchImpl(signed.url, {
        method: signed.method,
        headers: signed.headers,
        ...(signed.body === undefined ? {} : { body: signed.body }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  /** Reads a small text body (XML replies) within the request deadline. */
  const readText = (response: Response, operation: string): Promise<string> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        void response.body?.cancel().catch(() => undefined);
        reject(new StorageUnavailable({ driver: "s3", operation, reason: "s3-body" }));
      }, timeout);
    });
    return Promise.race([response.text(), deadline]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  };

  /**
   * Wraps a downloaded body so that a pause longer than `bodyIdleTimeout`
   * between two chunks fails the stream (and cancels the source) instead of
   * hanging the consumer forever; a transfer that keeps flowing is never cut.
   */
  const guardBody = (body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> => {
    const reader = body.getReader();
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const idle = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`s3 download body idle for ${bodyIdleTimeout} ms`)),
            bodyIdleTimeout,
          );
        });
        try {
          const next = await Promise.race([reader.read(), idle]);
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        } catch (cause) {
          await reader.cancel(cause).catch(() => undefined);
          controller.error(cause);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      },
      cancel: (reason) => reader.cancel(reason),
    });
  };

  const request = (input: Parameters<typeof doFetch>[0]): Effect.Effect<Response, StorageError> =>
    Effect.tryPromise({
      try: () => doFetch(input),
      catch: (): StorageError =>
        new StorageUnavailable({
          driver: "s3",
          operation: input.method.toLowerCase(),
          reason: "s3-network",
        }),
    });

  const failure = (operation: string, status: number, key?: string): StorageError => {
    if (status === 404) {
      return new ObjectNotFound({ key: key ?? "" });
    }
    const unavailable = status === 429 || status === 408 || status >= 500;
    return unavailable
      ? new StorageUnavailable({ driver: "s3", operation, reason: `s3-${status}` })
      : new StorageRejected({ driver: "s3", operation, reason: `s3-${status}` });
  };

  const metaHeaders = (input: PutInput): Record<string, string> => {
    const headers: Record<string, string> = {
      "content-type": input.contentType,
      "x-amz-meta-disposition": input.disposition ?? "attachment",
    };
    if (input.metadata !== undefined) {
      for (const [name, value] of Object.entries(input.metadata)) {
        const header = metadataHeaderName(name);
        if (header !== undefined) headers[`x-amz-meta-${header}`] = value.slice(0, 1_024);
      }
    }
    return headers;
  };

  const fromHeaders = (key: ObjectKey, headers: Headers, size: number): StoredObject => {
    const metadata: Record<string, string> = {};
    for (const [name, value] of headers.entries()) {
      if (name.startsWith("x-amz-meta-") && name !== "x-amz-meta-disposition") {
        metadata[name.slice("x-amz-meta-".length)] = value;
      }
    }
    const lastModified = headers.get("last-modified");
    const etag = headers.get("etag");
    return {
      key,
      contentType: headers.get("content-type") ?? "application/octet-stream",
      size,
      ...(etag !== null && { etag }),
      ...(lastModified !== null && { lastModified: new Date(lastModified) }),
      disposition:
        (headers.get("x-amz-meta-disposition") as StoredObject["disposition"]) ?? "attachment",
      ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
    };
  };

  /** PUT responses carry no object metadata server-side; echo the request's. */
  const storedFromPut = (input: PutInput, headers: Headers, size: number): StoredObject => {
    const etag = headers.get("etag");
    const lastModified = headers.get("last-modified");
    return {
      key: input.key,
      contentType: input.contentType,
      size,
      ...(etag !== null && { etag }),
      ...(lastModified !== null && { lastModified: new Date(lastModified) }),
      disposition: input.disposition ?? "attachment",
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    };
  };

  const putBytes = (
    input: PutInput,
    bytes: Uint8Array,
    headers: Record<string, string>,
  ): Effect.Effect<StoredObject, StorageError> =>
    Effect.gen(function* () {
      const response = yield* request({
        method: "PUT",
        url: objectUrl(input.key),
        headers,
        payloadHash: sha256Hex(bytes),
        body: bytes,
      });
      if (response.status !== 200) {
        return yield* failure("put", response.status, keyToString(input.key));
      }
      return storedFromPut(input, response.headers, bytes.byteLength);
    });

  const putStream = (
    input: PutInput,
    headers: Record<string, string>,
  ): Effect.Effect<StoredObject, StorageError> =>
    Effect.tryPromise({
      try: async (): Promise<StoredObject> => {
        const reader = (input.body as ReadableStream<Uint8Array>).getReader();
        const keyString = keyToString(input.key);
        let buffered = new Uint8Array(0);
        let total = 0;
        let uploadId: string | undefined;
        const partTags: Array<string> = [];

        // Multipart is initiated lazily, on the first full part: a stream
        // that ends within one part is a single PUT.
        const initiate = async (): Promise<string> => {
          const response = await doFetch({
            method: "POST",
            url: objectUrl(input.key, "uploads="),
            headers,
          });
          if (response.status !== 200) {
            throw failure("put-multipart-initiate", response.status, keyString);
          }
          const id = /<UploadId>([^<]+)<\/UploadId>/u.exec(
            await readText(response, "put-multipart-initiate"),
          )?.[1];
          if (id === undefined) {
            throw new StorageUnavailable({
              driver: "s3",
              operation: "put-multipart-initiate",
              reason: "s3-missing-upload-id",
            });
          }
          return id;
        };

        // Each part goes out as soon as it fills, one at a time, so memory
        // holds one part plus one chunk, never the whole blob.
        const uploadPart = async (part: Uint8Array): Promise<void> => {
          uploadId ??= await initiate();
          const partNumber = partTags.length + 1;
          const response = await doFetch({
            method: "PUT",
            url: objectUrl(
              input.key,
              `partNumber=${partNumber}&uploadId=${encodeURIComponent(uploadId)}`,
            ),
            headers,
            payloadHash: sha256Hex(part),
            body: part,
          });
          if (response.status !== 200) {
            throw failure("put-part", response.status, keyString);
          }
          partTags.push(response.headers.get("etag") ?? `part-${partNumber}`);
        };

        // Anything that fails after initiate leaves parts behind in the
        // bucket unless the upload is aborted; best effort, the original
        // failure is what the caller sees. An initiate reply without an
        // UploadId cannot be aborted (there is no id to name), so that one
        // malformed-provider case is left to the bucket's lifecycle rule.
        const abort = async (): Promise<void> => {
          if (uploadId === undefined) return;
          await doFetch({
            method: "DELETE",
            url: objectUrl(input.key, `uploadId=${encodeURIComponent(uploadId)}`),
          }).catch(() => undefined);
        };

        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            const chunk = next.value ?? new Uint8Array(0);
            total += chunk.byteLength;
            const merged = new Uint8Array(buffered.byteLength + chunk.byteLength);
            merged.set(buffered, 0);
            merged.set(chunk, buffered.byteLength);
            buffered = merged;
            while (buffered.byteLength >= partSize) {
              await uploadPart(buffered.slice(0, partSize));
              buffered = buffered.slice(partSize);
            }
          }

          if (uploadId === undefined) {
            const single = await doFetch({
              method: "PUT",
              url: objectUrl(input.key),
              headers,
              payloadHash: sha256Hex(buffered),
              body: buffered,
            });
            if (single.status !== 200) {
              throw failure("put", single.status, keyString);
            }
            return storedFromPut(input, single.headers, total);
          }

          if (buffered.byteLength > 0) await uploadPart(buffered);
          const completeBody = `<CompleteMultipartUpload>${partTags
            .map(
              (etag, index) =>
                `<Part><PartNumber>${index + 1}</PartNumber><ETag>${etag}</ETag></Part>`,
            )
            .join("")}</CompleteMultipartUpload>`;
          const complete = await doFetch({
            method: "POST",
            url: objectUrl(input.key, `uploadId=${encodeURIComponent(uploadId)}`),
            headers: { ...headers, "content-type": "application/xml" },
            payloadHash: sha256Hex(completeBody),
            body: completeBody,
          });
          if (complete.status !== 200) {
            throw failure("put-multipart-complete", complete.status, keyString);
          }
          return {
            key: input.key,
            contentType: input.contentType,
            size: total,
            disposition: input.disposition ?? "attachment",
            ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
          };
        } catch (cause) {
          await abort();
          await reader.cancel(cause).catch(() => undefined);
          throw cause;
        }
      },
      catch: (cause): StorageError =>
        typeof cause === "object" &&
        cause !== null &&
        "_tag" in cause &&
        typeof (cause as { _tag: unknown })._tag === "string" &&
        [
          "ObjectNotFound",
          "StorageRejected",
          "StorageUnavailable",
          "StorageValidationError",
        ].includes((cause as { _tag: string })._tag)
          ? (cause as StorageError)
          : new StorageUnavailable({
              driver: "s3",
              operation: "put-stream",
              reason: "s3-stream",
            }),
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
        const headers = metaHeaders(input);
        const stored =
          input.body instanceof Uint8Array
            ? yield* putBytes(input, input.body, headers)
            : yield* putStream(input, headers);
        return stored;
      }),
    get: (key) =>
      Effect.gen(function* () {
        const response = yield* request({ method: "GET", url: objectUrl(key) });
        if (response.status === 404) return yield* new ObjectNotFound({ key: keyToString(key) });
        if (response.status !== 200)
          return yield* failure("get", response.status, keyToString(key));
        const size = Number(response.headers.get("content-length") ?? "0");
        const meta = fromHeaders(key, response.headers, size);
        const body = guardBody(response.body ?? new ReadableStream<Uint8Array>());
        return retrieved(meta, body, policy);
      }),
    head: (key) =>
      Effect.gen(function* () {
        const response = yield* request({ method: "HEAD", url: objectUrl(key) });
        if (response.status === 404) return yield* new ObjectNotFound({ key: keyToString(key) });
        if (response.status !== 200)
          return yield* failure("head", response.status, keyToString(key));
        return fromHeaders(
          key,
          response.headers,
          Number(response.headers.get("content-length") ?? "0"),
        );
      }),
    delete: (key) =>
      Effect.gen(function* () {
        const response = yield* request({ method: "DELETE", url: objectUrl(key) });
        if (response.status === 404 || response.status === 204) return;
        if (response.status !== 200)
          return yield* failure("delete", response.status, keyToString(key));
      }),
    list: (prefix) =>
      Effect.gen(function* () {
        const fullPrefix =
          options.keyPrefix === undefined ? prefix : `${options.keyPrefix}/${prefix}`;
        const response = yield* request({
          method: "GET",
          url: new URL(
            `${endpoint}/${options.bucket}?list-type=2&prefix=${encodeURIComponent(fullPrefix)}`,
          ),
        });
        if (response.status !== 200) return yield* failure("list", response.status);
        const xml = yield* Effect.tryPromise({
          try: () => readText(response, "list"),
          catch: () =>
            new StorageUnavailable({ driver: "s3", operation: "list", reason: "s3-body" }),
        });
        const results: Array<StoredObject> = [];
        for (const block of xml.match(/<Contents>[\s\S]*?<\/Contents>/gu) ?? []) {
          const field = (name: string): string | undefined =>
            new RegExp(`<${name}>([^<]*)</${name}>`, "u").exec(block)?.[1];
          const keyRaw = field("Key");
          const size = field("Size");
          if (keyRaw === undefined || size === undefined) continue;
          const stripped =
            options.keyPrefix === undefined || !keyRaw.startsWith(`${options.keyPrefix}/`)
              ? keyRaw
              : keyRaw.slice(options.keyPrefix.length + 1);
          const listEtag = field("ETag");
          results.push({
            key: stripped as ObjectKey,
            contentType: "application/octet-stream",
            size: Number(size),
            ...(listEtag !== undefined && { etag: listEtag }),
            ...(field("LastModified") === undefined
              ? {}
              : { lastModified: new Date(field("LastModified") ?? "") }),
            disposition: "attachment",
          });
        }
        return results;
      }),
  };

  return instrumented("s3", storage);
};
