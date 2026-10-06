import { status } from "@grpc/grpc-js";
import { Data, ParseResult, Schema } from "effect";

export { status as Status };
export const statusMessage = (code: number): string => {
  switch (code) {
    case status.CANCELLED:
      return "Call cancelled";
    case status.INVALID_ARGUMENT:
      return "Invalid request";
    case status.DEADLINE_EXCEEDED:
      return "Deadline exceeded";
    case status.NOT_FOUND:
      return "Not found";
    case status.ALREADY_EXISTS:
      return "Already exists";
    case status.PERMISSION_DENIED:
      return "Permission denied";
    case status.RESOURCE_EXHAUSTED:
      return "Resource limit exceeded";
    case status.FAILED_PRECONDITION:
      return "Business failure";
    case status.ABORTED:
      return "Conflict";
    case status.UNIMPLEMENTED:
      return "Method unavailable";
    case status.UNAVAILABLE:
      return "Service unavailable";
    case status.UNAUTHENTICATED:
      return "Authentication required";
    default:
      return "Unexpected failure";
  }
};
/** Only fixed status text reaches callers. Transport errors never retain a cause. */
export class GrpcError extends Data.TaggedError("GrpcError")<{ readonly code: status }> {
  get classification(): "transient" | "permanent" | "conflict" {
    return this.code === status.ABORTED || this.code === status.ALREADY_EXISTS
      ? "conflict"
      : [status.UNAVAILABLE, status.DEADLINE_EXCEEDED, status.RESOURCE_EXHAUSTED].includes(
            this.code,
          )
        ? "transient"
        : "permanent";
  }
  override get message(): string {
    return statusMessage(this.code);
  }
}
export class GrpcConfigError extends Data.TaggedError("GrpcConfigError")<{
  readonly violations: ReadonlyArray<string>;
}> {
  readonly classification = "permanent" as const;
  override get message(): string {
    return this.violations.join("; ");
  }
}
// Validate application-composed authorization contracts without depending on auth packages.
const taxonomy = Schema.Union(
  Schema.Struct({
    _tag: Schema.Literal("ValidationFailed"),
    subject: Schema.String,
    issues: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    _tag: Schema.Literal("Unauthenticated"),
    permission: Schema.optional(Schema.String),
    reason: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    _tag: Schema.Literal("PermissionDenied"),
    permission: Schema.String,
    principal: Schema.String,
  }),
  Schema.Struct({ _tag: Schema.Literal("Unauthorized"), tag: Schema.String }),
  Schema.Struct({
    _tag: Schema.Literal("ConcurrencyConflict"),
    entity: Schema.String,
    id: Schema.String,
    expectedVersion: Schema.Number,
    actualVersion: Schema.Number,
  }),
  Schema.Struct({
    _tag: Schema.Literal("IdempotencyMismatch", "IdempotencyInFlight"),
    tag: Schema.String,
    key: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.Literal("DispatchTimeout"),
    tag: Schema.String,
    timeoutMillis: Schema.Number,
  }),
  Schema.Struct({ _tag: Schema.Literal("NotFound"), entity: Schema.String, id: Schema.String }),
);
const isTaxonomyError = Schema.is(taxonomy);
/** Validate framework contracts, never copy an arbitrary object's message or status. */
export const toStatus = (error: unknown): status => {
  if (error instanceof GrpcError) return error.code;
  if (ParseResult.isParseError(error)) return status.INVALID_ARGUMENT;
  if (!isTaxonomyError(error)) return status.INTERNAL;
  switch (error._tag) {
    case "ValidationFailed":
      return status.INVALID_ARGUMENT;
    case "Unauthenticated":
      return status.UNAUTHENTICATED;
    case "Unauthorized":
    case "PermissionDenied":
      return status.PERMISSION_DENIED;
    case "ConcurrencyConflict":
    case "IdempotencyMismatch":
      return status.ABORTED;
    case "IdempotencyInFlight":
      return status.UNAVAILABLE;
    case "DispatchTimeout":
      return status.DEADLINE_EXCEEDED;
    case "NotFound":
      return status.NOT_FOUND;
    default:
      return status.INTERNAL;
  }
};
