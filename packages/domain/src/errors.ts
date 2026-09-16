import { Data } from "effect";

/**
 * Failure classification per the production contract: transient failures may
 * be retried, permanent ones must not, conflicts need caller resolution.
 */
export type FailureClass = "transient" | "permanent" | "conflict";

/** A business rule was violated. Permanent: retrying cannot help. */
export class InvariantViolation extends Data.TaggedError("InvariantViolation")<{
  readonly rule: string;
  readonly details?: string;
}> {
  readonly classification: FailureClass = "permanent";
  override get message(): string {
    return this.details === undefined ? this.rule : `${this.rule}: ${this.details}`;
  }
}

/** The addressed aggregate/entity does not exist. */
export class NotFound extends Data.TaggedError("NotFound")<{
  readonly entity: string;
  readonly id: string;
}> {
  readonly classification: FailureClass = "permanent";
  override get message(): string {
    return `${this.entity} ${this.id} not found`;
  }
}

/**
 * Optimistic concurrency check failed: the aggregate changed since it was
 * loaded. Callers decide whether to reload and retry the whole command.
 */
export class ConcurrencyConflict extends Data.TaggedError("ConcurrencyConflict")<{
  readonly entity: string;
  readonly id: string;
  readonly expectedVersion: number;
  readonly actualVersion: number;
}> {
  readonly classification: FailureClass = "conflict";
  override get message(): string {
    return `${this.entity} ${this.id}: expected version ${this.expectedVersion}, found ${this.actualVersion}`;
  }
}

/** Boundary validation failed: the input never reached the domain. */
export class ValidationFailed extends Data.TaggedError("ValidationFailed")<{
  readonly subject: string;
  readonly issues: ReadonlyArray<string>;
}> {
  readonly classification: FailureClass = "permanent";
  override get message(): string {
    return `${this.subject} is invalid:\n${this.issues.map((i) => `  - ${i}`).join("\n")}`;
  }
}

export type DomainError = InvariantViolation | NotFound | ConcurrencyConflict | ValidationFailed;

/**
 * A persistence adapter could not complete an operation. Kept in the typed
 * channel so callers can recover without inspecting defects. The immediate
 * cause is diagnostic only and must not be sent to clients.
 * No automatic retry is assumed: writes may have committed, and storage
 * errors can include invalid queries or corrupt data as well as outages.
 */
export class PersistenceError extends Data.TaggedError("PersistenceError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {
  readonly classification = "permanent" as const;
  override get message(): string {
    return `Persistence operation failed: ${this.operation}`;
  }
}
