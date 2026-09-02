# @structure-ai/storage

Blob storage behind one port. Two drivers — local filesystem and S3 (SigV4-signed, multipart streaming, no SDK dependency) — pass the same behavioral suite. Keys are opaque branded ids; the content-disposition policy is enforced at the port: **user content is served as `attachment` with `X-Content-Type-Options: nosniff` unless the caller explicitly declares `inline-if-isolated` AND the content type is allowlisted** (images and plain text only — never HTML/SVG/PDF).

## Quick start

```ts
import { makeLocalStorage, objectKey, makeS3Storage } from "@structure-ai/storage";
import { Effect, Redacted } from "effect";

const storage = makeLocalStorage({ rootDir: "/var/lib/app/uploads" });
// or: makeS3Storage({ bucket, region, accessKeyId, secretAccessKey, endpoint? })

const program = Effect.gen(function* () {
  const key = yield* objectKey("avatars/user-1.png");
  const stored = yield* storage.put({
    key,
    body: pngBytes, // Uint8Array or ReadableStream<Uint8Array> — streamed, never buffered whole
    contentType: "image/png",
    disposition: "inline-if-isolated",
    metadata: { ownerId: "user-1" },
  });

  const got = yield* storage.get(key);
  // Hand straight to an @structure-ai/http handler without buffering:
  // HttpServerResponse.stream(got.body, { headers: got.servingHeaders })
});
```

## Port

```ts
interface Storage {
  put(input: PutInput): Effect<StoredObject, StorageError>;   // bytes or stream
  get(key): Effect<RetrievedObject, StorageError>;            // stream + serving headers
  head(key): Effect<StoredObject, StorageError>;
  delete(key): Effect<void, StorageError>;                    // idempotent
  list(prefix): Effect<ReadonlyArray<StoredObject>, StorageError>;
}
```

- **Keys** — `objectKey(raw)` validates and brands; `randomObjectKey({ prefix, extension })` mints unguessable ones. No `.`/`..` segments, no backslashes, no absolute paths, restricted charset — and the local driver re-resolves every path under its root before touching the filesystem (belt and braces).
- **Disposition** — `servingHeaders` on every `get`: `attachment; filename="…"` by default, `inline` only for `inline-if-isolated` objects whose content type is in the allowlist (`image/png|jpeg|gif|webp|avif`, `text/plain`; extend via `dispositionPolicy([...])` or `STORAGE_INLINE_CONTENT_TYPES`). `nosniff` always.
- **Failures** — `StorageValidationError`/`ObjectNotFound` (permanent), `StorageRejected` (permanent 4xx), `StorageUnavailable` (transient network/5xx — drivers retry with a bounded jittered schedule).

## Drivers

| Driver | Notes |
| --- | --- |
| `makeLocalStorage({ rootDir, policy? })` | Objects at their key path + `.meta.json` sidecar. Owner-only permissions (0700 dirs / 0600 files), traversal-proof resolution, streaming writes via a chunked pump. |
| `makeS3Storage({ bucket, region, accessKeyId, secretAccessKey, endpoint?, keyPrefix?, partSize? })` | Path-style, hand-rolled SigV4 (no SDK). Fixed bytes → one signed PUT; streams → bounded `partSize` buffers (default 8 MiB), single PUT when small, multipart upload when larger — memory stays capped at one part. `fetchImpl` injectable for tests. |

## Observability & readiness

Every operation is wrapped with boundary metrics (`storage_<driver>_<op>_calls_total` / `_errors_total` / `_duration_ms`) and a structured log line carrying driver, operation, key, and size — never body or metadata content. `ObjectNotFound` is not counted as a driver failure. `storageReadinessCheck(storage)` registers a `@structure-ai/runtime` readiness check (ready when a root `list` answers).

## Settings

`storageSettings` (`@structure-ai/config`) selects driver + credentials (secrets `Redacted`); `storageFromSettings(settings)` validates the combination at composition.

| Name | Type | Required | Default | Secret |
| --- | --- | --- | --- | --- |
| `STORAGE_DRIVER` | `"local" \| "s3"` | no | `local` | |
| `STORAGE_DATA_DIR` | string | driver=local | — | |
| `STORAGE_S3_BUCKET` | string | driver=s3 | — | |
| `STORAGE_S3_REGION` | string | driver=s3 | — | |
| `STORAGE_S3_ENDPOINT` | url | no | AWS | |
| `STORAGE_S3_ACCESS_KEY_ID` | string | driver=s3 | — | |
| `STORAGE_S3_SECRET_ACCESS_KEY` | secret | driver=s3 | — | yes |
| `STORAGE_INLINE_CONTENT_TYPES` | string (csv) | no | — | |
