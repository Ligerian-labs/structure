/**
 * `@structure-ai/storage` — blob storage behind one port: local filesystem
 * and S3 drivers (SigV4, multipart streaming), opaque typed keys,
 * disposition policy with nosniff default, readiness check, per-driver
 * per-operation metrics.
 */

export { type LocalStorageOptions, makeLocalStorage } from "./drivers/local.js";
export { makeS3Storage, type S3StorageOptions } from "./drivers/s3.js";
export {
  ObjectNotFound,
  type StorageError,
  type StorageFailureClass,
  StorageRejected,
  StorageUnavailable,
  StorageValidationError,
} from "./errors.js";
export {
  isValidKey,
  keyToString,
  type ObjectKey,
  objectKey,
  randomObjectKey,
} from "./key.js";
export {
  DEFAULT_INLINE_ALLOWLIST,
  type Disposition,
  type DispositionPolicy,
  dispositionPolicy,
  servingHeaders,
  validContentType,
} from "./policy.js";
export { storageReadinessCheck } from "./readiness.js";
export {
  type StorageSettingsValue,
  storageFromSettings,
  storageSettings,
} from "./settings.js";
export type { SigV4Credentials } from "./sigv4.js";
export {
  instrumented,
  type ObjectBody,
  type PutInput,
  type RetrievedObject,
  retrieved,
  type Storage,
  type StorageOperation,
  type StoredObject,
} from "./storage.js";
