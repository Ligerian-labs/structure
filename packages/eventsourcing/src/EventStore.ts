import type { ConcurrencyConflict, EventMetadata } from "@structure/domain";
import { Context, type Effect, type Schema, type Stream } from "effect";

/**
 * `EventMetadata` in its encoded (JSON-safe) form: `occurredAt` is an ISO
 * string. This is what adapters persist next to the payload.
 */
export type StoredEventMetadata = Schema.Schema.Encoded<typeof EventMetadata>;

/** An event to append: wire form plus its stamped metadata. */
export interface AppendEvent {
  readonly type: string;
  readonly schemaVersion: number;
  readonly payload: unknown;
  readonly metadata: StoredEventMetadata;
}

/**
 * An event as persisted: `version` numbers events within one stream starting
 * at 1; `position` is the store-wide total order (starting at 1) used by
 * projections to checkpoint progress.
 */
export interface StoredEvent {
  readonly position: bigint;
  readonly streamName: string;
  readonly version: number;
  readonly type: string;
  readonly schemaVersion: number;
  readonly payload: unknown;
  readonly metadata: StoredEventMetadata;
}

/** Version range assigned to an accepted append. */
export interface AppendResult {
  readonly firstVersion: number;
  readonly lastVersion: number;
}

/**
 * Append-only event log with optimistic concurrency per stream and a global
 * position for projections.
 */
export interface EventStoreService {
  /**
   * Atomically appends `events` to `streamName`.
   *
   * `expectedVersion` is the last version the writer observed (0 means the
   * stream must not exist yet); if the stream has moved on, the append fails
   * with `ConcurrencyConflict` and nothing is written. `events` should be
   * non-empty; an empty append is a version-checked no-op.
   *
   * The `ConcurrencyConflict` entity/id are derived by splitting the stream
   * name at its first `-` (see `AggregateStore` stream naming), so stream
   * categories must not contain `-`.
   */
  readonly append: (
    streamName: string,
    expectedVersion: number,
    events: ReadonlyArray<AppendEvent>,
  ) => Effect.Effect<AppendResult, ConcurrencyConflict>;
  /**
   * Events of one stream in version order. `fromVersion` is inclusive and
   * defaults to 1. A missing stream yields an empty stream of events.
   */
  readonly read: (
    streamName: string,
    options?: { readonly fromVersion?: number },
  ) => Stream.Stream<StoredEvent>;
  /**
   * All events across streams in global `position` order — the feed
   * projections consume. `fromPosition` is inclusive and defaults to 1.
   * When `batchSize` is set the stream may end after `batchSize` events;
   * callers poll again from the last seen position to continue.
   */
  readonly readAll: (options?: {
    readonly fromPosition?: bigint;
    readonly batchSize?: number;
  }) => Stream.Stream<StoredEvent>;
}

/** Service tag for the event store port. */
export class EventStore extends Context.Tag("@structure/eventsourcing/EventStore")<
  EventStore,
  EventStoreService
>() {}
