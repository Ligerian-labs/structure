import { Data } from "effect";

/**
 * Infrastructure failure from the DynamoDB adapter: SDK errors that are not
 * concurrency signals, classified per the repo's error taxonomy.
 */
export class DynamoDbError extends Data.TaggedError("DynamoDbError")<{
  readonly classification: "transient" | "permanent";
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Exception names DynamoDB signals for retryable capacity/traffic states. */
const transientTags = new Set([
  "ProvisionedThroughputExceededException",
  "ThrottlingException",
  "RequestLimitExceeded",
  "InternalServerError",
  "TransactionConflictException",
  "TransactionInProgressException",
  "TimeoutException",
  "RequestTimeout",
]);

const tagOf = (error: unknown): string | undefined => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const tag = (error as { readonly _tag: unknown })._tag;
    if (typeof tag === "string") return tag;
  }
  if (error instanceof Error && error.name !== "Error") return error.name;
  return undefined;
};

/** Whether an SDK failure means "the stream-head condition lost a race". */
export const isHeadConflict = (error: unknown): boolean => {
  const tag = tagOf(error);
  if (tag === "ConditionalCheckFailedException") return true;
  if (tag === "TransactionCanceledException") {
    // Reasons align with TransactItems; index 0 is the stream-head update.
    const reasons = (
      error as { readonly CancellationReasons?: ReadonlyArray<{ readonly Code?: string }> }
    ).CancellationReasons;
    return reasons === undefined || reasons[0]?.Code === "ConditionalCheckFailed";
  }
  return false;
};

/** Wraps an SDK failure in the adapter's classified tagged error. */
export const dynamoError = (error: unknown): DynamoDbError => {
  const tag = tagOf(error) ?? "unknown";
  const classification = transientTags.has(tag) ? "transient" : "permanent";
  const message = error instanceof Error ? error.message : undefined;
  const rendered =
    message !== undefined && typeof message === "string" && message.length > 0
      ? message
      : safeStringify(error);
  return new DynamoDbError({ classification, message: `${tag}: ${rendered}`, cause: error });
};

const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

/**
 * Splits a stream name into the conflict's entity/id at the first `-`,
 * mirroring the SQL adapters and the in-memory event store (stream
 * categories must not contain `-`).
 */
export const conflictIdentity = (streamName: string): { entity: string; id: string } => {
  const separator = streamName.indexOf("-");
  return separator === -1
    ? { entity: streamName, id: streamName }
    : { entity: streamName.slice(0, separator), id: streamName.slice(separator + 1) };
};
