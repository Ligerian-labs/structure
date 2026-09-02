import { Data } from "effect";

/**
 * Connection-level failure: socket closed, handshake rejected, or request
 * timed out. Always transient — a stateless Nisshi broker comes back and a
 * retry re-establishes everything.
 */
export class NisshiConnectionError extends Data.TaggedError("NisshiConnectionError")<{
  readonly reason: string;
  readonly cause?: unknown;
}> {
  readonly classification = "transient" as const;
}

/** Broker answered a request with a nonzero Kafka error code. */
export class NisshiApiError extends Data.TaggedError("NisshiApiError")<{
  readonly code: number;
  readonly message: string;
  readonly retriable: boolean;
}> {
  readonly classification: "transient" | "permanent" = this.retriable ? "transient" : "permanent";
}

/** The topic exists but does not match the single-partition contract. */
export class NisshiTopicConfigurationError extends Data.TaggedError(
  "NisshiTopicConfigurationError",
)<{
  readonly topic: string;
  readonly reason: string;
}> {
  readonly classification = "permanent" as const;
}

/** A produce attempt failed after versions were reserved — see the ADR. */
export class NisshiProduceError extends Data.TaggedError("NisshiProduceError")<{
  readonly topic: string;
  readonly cause: unknown;
}> {
  readonly classification = "transient" as const;
}

/** Response bytes violate the wire protocol or the envelope contract. */
export class NisshiProtocolError extends Data.TaggedError("NisshiProtocolError")<{
  readonly reason: string;
}> {
  readonly classification = "permanent" as const;
}

// Kafka error codes we care about. Everything unlisted maps to retriable:
// on a stateless broker most odd failures clear by the next attempt.
const NON_RETRIABLE_CODES = new Set([
  1, // OFFSET_OUT_OF_RANGE
  3, // UNKNOWN_TOPIC_OR_PARTITION
  17, // INVALID_TOPIC_EXCEPTION
]);

/** Maps a Kafka error code to a `NisshiApiError`. */
export const apiError = (code: number, message: string): NisshiApiError =>
  new NisshiApiError({
    code,
    message,
    retriable: !NON_RETRIABLE_CODES.has(code),
  });
