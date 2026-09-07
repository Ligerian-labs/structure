import type { ConcurrencyConflict, EventMetadata } from "@structure-ai/domain";
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

/** Options of `EventStoreService.readAll`. */
export interface ReadAllOptions {
  /** Inclusive lower bound on the global position (default 1). */
  readonly fromPosition?: bigint;
  /** When set, the stream may end after this many events. */
  readonly batchSize?: number;
  /**
   * Keep only events whose envelope `partition` is this value (or one of
   * these values). Events without a partition never match, so an
   * unpartitioned store filtered by partition yields nothing; an empty
   * array matches nothing. Positions, order, and the checkpoint guarantee
   * are those of the unfiltered feed.
   */
  readonly partition?: string | ReadonlyArray<string>;
}

/**
 * Adapter helper: the distinct partitions a `readAll` call asked to keep,
 * or `undefined` when it asked for no filter.
 */
export const readAllPartitions = (
  partition: ReadAllOptions["partition"],
): ReadonlyArray<string> | undefined =>
  partition === undefined
    ? undefined
    : typeof partition === "string"
      ? [partition]
      : [...new Set(partition)];

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
   *
   * Adapters make positions visible in commit order: once the feed has
   * yielded position N, every committed event at a lower position was
   * already visible, so a consumer may checkpoint at the last position it
   * saw without losing an event whose append committed later.
   *
   * `partition` narrows the feed to the events of one or several envelope
   * partitions (see `ReadAllOptions`); the surviving events keep their
   * global positions and order, so the checkpoint guarantee holds within
   * the filtered feed. An adapter that cannot honour the filter must fail,
   * never silently return the unfiltered feed.
   */
  readonly readAll: (options?: ReadAllOptions) => Stream.Stream<StoredEvent>;
}

/** Service tag for the event store port. */
export class EventStore extends Context.Tag("@structure-ai/eventsourcing/EventStore")<
  EventStore,
  EventStoreService
>() {}
