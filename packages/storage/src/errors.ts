import { Data } from "effect";

export type StorageFailureClass = "transient" | "permanent";

/** The key or options never reached a driver; retrying cannot help. */
export class StorageValidationError extends Data.TaggedError("StorageValidationError")<{
  readonly field: string;
  readonly reason: string;
}> {
  readonly classification: StorageFailureClass = "permanent";
  override get message(): string {
    return `${this.field}: ${this.reason}`;
  }
}

/** The addressed object does not exist. */
export class ObjectNotFound extends Data.TaggedError("ObjectNotFound")<{
  readonly key: string;
}> {
  readonly classification: StorageFailureClass = "permanent";
  override get message(): string {
    return `no stored object at key ${this.key}`;
  }
}

/**
 * The driver failed transiently (network error, timeout, 5xx). Drivers
 * already retry these with a bounded jittered schedule; this is the
 * exhausted result.
 */
export class StorageUnavailable extends Data.TaggedError("StorageUnavailable")<{
  readonly driver: string;
  readonly operation: string;
  readonly reason: string;
}> {
  readonly classification: StorageFailureClass = "transient";
  override get message(): string {
    return `${this.driver} ${this.operation} failed transiently (${this.reason})`;
  }
}

/**
 * The driver permanently rejected the operation (403/400 — credentials,
 * bucket, or request shape). Not retried.
 */
export class StorageRejected extends Data.TaggedError("StorageRejected")<{
  readonly driver: string;
  readonly operation: string;
  readonly reason: string;
}> {
  readonly classification: StorageFailureClass = "permanent";
  override get message(): string {
    return `${this.driver} ${this.operation} was rejected (${this.reason})`;
  }
}

export type StorageError =
  | ObjectNotFound
  | StorageRejected
  | StorageUnavailable
  | StorageValidationError;
