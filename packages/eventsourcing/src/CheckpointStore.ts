import { Context, type Effect } from "effect";

/**
 * Tracks how far a named consumer has progressed through the global event
 * feed. Positions refer to `StoredEvent.position`; a consumer that has seen
 * nothing is at position 0.
 */
export interface CheckpointStoreService {
  /** Last processed position for `name`; 0n when the consumer never ran. */
  readonly load: (name: string) => Effect.Effect<bigint>;
  /** Records `position` as the last processed position for `name`. */
  readonly save: (name: string, position: bigint) => Effect.Effect<void>;
}

/** Service tag for the checkpoint store port. */
export class CheckpointStore extends Context.Tag("@structure-ai/eventsourcing/CheckpointStore")<
  CheckpointStore,
  CheckpointStoreService
>() {}
