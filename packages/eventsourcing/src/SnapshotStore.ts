import { Context, type Effect, type Option } from "effect";

/**
 * A point-in-time capture of an aggregate's folded state. `state` is stored
 * raw (no schema validation on load): snapshots are a pure cache of the
 * event stream. To invalidate all snapshots after changing the state shape,
 * bump the aggregate's `name` — the stream name changes and old snapshots
 * (and streams) are no longer addressed.
 */
export interface Snapshot {
  readonly state: unknown;
  readonly version: number;
}

/**
 * Optional cache of aggregate state so `load` does not have to fold the
 * whole stream. Correctness never depends on it: losing snapshots only
 * costs a longer rehydration.
 */
export interface SnapshotStoreService {
  /** Latest snapshot for a stream, if any. */
  readonly load: (streamName: string) => Effect.Effect<Option.Option<Snapshot>>;
  /** Stores `snapshot` as the latest for the stream, replacing any previous one. */
  readonly save: (streamName: string, snapshot: Snapshot) => Effect.Effect<void>;
}

/** Service tag for the snapshot store port. */
export class SnapshotStore extends Context.Tag("@structure-ai/eventsourcing/SnapshotStore")<
  SnapshotStore,
  SnapshotStoreService
>() {}
