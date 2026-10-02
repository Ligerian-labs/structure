import type { PersistenceError } from "@structure-ai/domain";
import { Context, Data, Effect } from "effect";
import type { StoredEventMetadata } from "./EventStore.js";

/**
 * Reserved event type name written in place of erased events. Registries
 * must not register an event type named `Erased`: a tombstone must never
 * decode into a domain event.
 */
export const ERASED_EVENT_TYPE = "Erased";

/** One erasure request: the stream, the last version the caller observed, and why. */
export interface StreamErasureRequest {
  readonly streamName: string;
  /**
   * Last version of the stream the caller observed (0 = the stream must not
   * exist or must already be empty). Mirrors `EventStore.append`: if the
   * stream has moved on, erasure fails `stream-modified` and nothing changes.
   */
  readonly expectedVersion: number;
  /** Why the content is being erased — stored in the erasure ledger. */
  readonly reason: string;
}

/** Outcome of one erasure call. */
export interface StreamErasureResult {
  /**
   * Events rewritten to tombstones by THIS call. `0` on the idempotent
   * retry of an already-erased stream (nothing is rewritten twice).
   */
  readonly erasedEvents: number;
  /** Version the stream is pinned at forever after (0 for a never-existing stream). */
  readonly lastVersion: number;
  /** When the content was destroyed (ISO). Stable across retries. */
  readonly erasedAt: string;
  /** Recorded audit reason. On a retry this is the originally recorded reason. */
  readonly reason: string;
}

export type StreamErasureFailureReason = "invalid-request" | "stream-modified";

/**
 * A stream erasure request is invalid, or the stream changed since the
 * caller observed it. `stream-modified` is a conflict: reload, re-observe,
 * and retry — exactly like a lost append race.
 */
export class StreamErasureError extends Data.TaggedError("StreamErasureError")<{
  readonly reason: StreamErasureFailureReason;
  readonly detail: string;
  /** Present with `stream-modified`: the versions the caller expected and the store found. */
  readonly conflict?: { readonly expectedVersion: number; readonly actualVersion: number };
}> {
  readonly classification: "permanent" | "conflict" =
    this.reason === "stream-modified" ? "conflict" : "permanent";
  override get message(): string {
    return `stream erasure ${this.reason}: ${this.detail}`;
  }
}

/**
 * Destructive retention for one aggregate stream: physically rewrites every
 * event of the stream to a payload-free tombstone, removes the stream's
 * snapshot, and records the erasure in a ledger.
 *
 * What erasure guarantees:
 *
 * - Event content is irreversibly destroyed — payload and metadata are
 *   replaced by a synthetic `Erased` tombstone carrying only the stream
 *   name, version, and erasure timestamp. Tombstones never decode into
 *   domain events (registries must not register the reserved `Erased` type).
 * - Global order is preserved: tombstones keep their `position` and
 *   `version`, so `readAll` stays gap-free and existing projection
 *   checkpoints remain valid. Projections skip tombstones as unknown types;
 *   a projection that already consumed the erased events keeps its state —
 *   rebuild read models from projections' own retention paths if their rows
 *   must also be dropped.
 * - The stream is pinned: the ledger remembers the erased version and every
 *   later append (any expected version) fails `ConcurrencyConflict`, so no
 *   new content can be written into an erased stream and the erased version
 *   range can never be resurrected.
 * - Idempotent: re-erasing an already-erased stream with the same
 *   `expectedVersion` rewrites nothing and returns the recorded result.
 *
 * Implemented by the in-memory, SQLite, and PostgreSQL adapters. The Nisshi
 * event store cannot support erasure (the topic is an immutable log, ADR-0015).
 */
export interface StreamEraserService {
  readonly eraseStream: (
    request: StreamErasureRequest,
  ) => Effect.Effect<StreamErasureResult, StreamErasureError | PersistenceError>;
}

/** Service tag for destructive stream erasure. */
export class StreamEraser extends Context.Tag("@structure-ai/eventsourcing/StreamEraser")<
  StreamEraser,
  StreamEraserService
>() {}

const erasureIdentity = (streamName: string): { entity: string; id: string } => {
  const separator = streamName.indexOf("-");
  return separator === -1
    ? { entity: streamName, id: streamName }
    : { entity: streamName.slice(0, separator), id: streamName.slice(separator + 1) };
};

/** @internal Validates an erasure request before any state is observed. */
export const prepareStreamErasure = (
  request: StreamErasureRequest,
): Effect.Effect<StreamErasureRequest, StreamErasureError> => {
  if (request.streamName.trim() === "") {
    return Effect.fail(
      new StreamErasureError({ reason: "invalid-request", detail: "streamName must not be empty" }),
    );
  }
  if (!Number.isSafeInteger(request.expectedVersion) || request.expectedVersion < 0) {
    return Effect.fail(
      new StreamErasureError({
        reason: "invalid-request",
        detail: `expectedVersion must be a non-negative safe integer, got ${String(request.expectedVersion)}`,
      }),
    );
  }
  if (request.reason.trim() === "") {
    return Effect.fail(
      new StreamErasureError({ reason: "invalid-request", detail: "reason must not be empty" }),
    );
  }
  return Effect.succeed(request);
};

/**
 * @internal The tombstone written over one erased event: same position and
 * version, no original content. Adapters use this so every store produces
 * byte-identical tombstones.
 */
export const erasedTombstone = (
  streamName: string,
  version: number,
  erasedAt: string,
): {
  readonly type: typeof ERASED_EVENT_TYPE;
  readonly schemaVersion: number;
  readonly payload: unknown;
  readonly metadata: StoredEventMetadata;
} => {
  const { entity, id } = erasureIdentity(streamName);
  return {
    type: ERASED_EVENT_TYPE,
    schemaVersion: 1,
    payload: { _tag: ERASED_EVENT_TYPE },
    metadata: {
      eventId: `erased:${streamName}:${version}`,
      occurredAt: erasedAt,
      aggregateName: entity,
      aggregateId: id,
      aggregateVersion: version,
    },
  };
};

/** @internal Constructs the stream-modified error consistently across adapters. */
export const streamErasureConflict = (
  streamName: string,
  expectedVersion: number,
  actualVersion: number,
): StreamErasureError =>
  new StreamErasureError({
    reason: "stream-modified",
    detail: `stream ${streamName} was modified: expected version ${expectedVersion}, found ${actualVersion}`,
    conflict: { expectedVersion, actualVersion },
  });
