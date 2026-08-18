import { Chunk, type Duration, Effect, Stream } from "effect";
import { CheckpointStore } from "./CheckpointStore.js";
import type { EventDecodeError, EventRegistry } from "./codec.js";
import { EventStore, type StoredEvent } from "./EventStore.js";

/**
 * Delivery context passed to every handler. `live` is `true` for normal
 * delivery (catch-up and polling) and `false` only while replaying during
 * `rebuild` — use it to suppress side effects (notifications, outgoing
 * messages) that must not fire again on replay.
 */
export interface ProjectionContext {
  readonly live: boolean;
}

/**
 * Handler for one event type. Delivery is at-least-once: a failure stops
 * the run before the checkpoint is saved, so the whole batch is redelivered
 * on the next attempt — handlers must be idempotent.
 */
export type ProjectionHandler<E, EH, R> = (
  event: E,
  stored: StoredEvent,
  context: ProjectionContext,
) => Effect.Effect<void, EH, R>;

/**
 * A projection folds the global event feed into a read model. Events are
 * applied strictly in global `position` order; progress is checkpointed
 * under `name` after each batch.
 */
export interface Projection<E extends { readonly _tag: string }, EH, R> {
  /** Unique consumer name — also the checkpoint key. Renaming resets progress. */
  readonly name: string;
  readonly registry: EventRegistry<E>;
  /** Handlers by event tag. Registered types without a handler are ignored. */
  readonly when: Partial<{
    readonly [Tag in E["_tag"]]: ProjectionHandler<Extract<E, { readonly _tag: Tag }>, EH, R>;
  }>;
}

/** Identity constructor that pins the projection's type parameters. */
export const make = <E extends { readonly _tag: string }, EH = never, R = never>(
  projection: Projection<E, EH, R>,
): Projection<E, EH, R> => projection;

/** Outcome of one catch-up: handled events and events skipped as unknown to the registry. */
export interface CatchupStats {
  readonly processed: number;
  readonly skipped: number;
}

export interface RunOptions {
  /** Delay between polls once caught up. Default 500 millis. */
  readonly pollInterval?: Duration.DurationInput;
  /** Max events fetched and checkpointed per batch. Default 100. */
  readonly batchSize?: number;
}

const catchupWith = <E extends { readonly _tag: string }, EH, R>(
  projection: Projection<E, EH, R>,
  live: boolean,
  batchSize: number,
): Effect.Effect<CatchupStats, EH | EventDecodeError, EventStore | CheckpointStore | R> =>
  Effect.gen(function* () {
    const store = yield* EventStore;
    const checkpoints = yield* CheckpointStore;
    const handlers = projection.when as Partial<Record<string, ProjectionHandler<E, EH, R>>>;
    let processed = 0;
    let skipped = 0;
    while (true) {
      const checkpoint = yield* checkpoints.load(projection.name);
      const batch = yield* Stream.runCollect(
        store.readAll({ fromPosition: checkpoint + 1n, batchSize }),
      );
      if (Chunk.isEmpty(batch)) {
        return { processed, skipped };
      }
      let position = checkpoint;
      for (const stored of batch) {
        if (!projection.registry.has(stored.type)) {
          skipped++;
          position = stored.position;
          continue;
        }
        const handler = handlers[stored.type];
        if (handler !== undefined) {
          const event = yield* projection.registry.decode(stored);
          yield* handler(event, stored, { live });
          processed++;
        }
        position = stored.position;
      }
      yield* checkpoints.save(projection.name, position);
    }
  });

/**
 * Processes every event from the current checkpoint to the head of the
 * feed, then returns. Events are handled in global order with `live: true`;
 * the checkpoint is saved after each batch, so a re-run applies nothing new.
 * Types unknown to the registry are skipped and counted; a handler failure
 * or decode failure of a known type aborts before the batch's checkpoint is
 * saved (at-least-once).
 */
export const catchup = <E extends { readonly _tag: string }, EH, R>(
  projection: Projection<E, EH, R>,
  options?: { readonly batchSize?: number },
): Effect.Effect<CatchupStats, EH | EventDecodeError, EventStore | CheckpointStore | R> =>
  catchupWith(projection, true, options?.batchSize ?? 100);

/**
 * Runs the projection forever: catch up to the head, sleep `pollInterval`,
 * repeat. Never returns; interrupt the fiber to stop it.
 */
export const run = <E extends { readonly _tag: string }, EH, R>(
  projection: Projection<E, EH, R>,
  options?: RunOptions,
): Effect.Effect<never, EH | EventDecodeError, EventStore | CheckpointStore | R> =>
  catchupWith(projection, true, options?.batchSize ?? 100).pipe(
    Effect.andThen(Effect.sleep(options?.pollInterval ?? "500 millis")),
    Effect.forever,
  );

/**
 * Rebuilds the read model from scratch: runs the caller's `reset` (drop
 * tables, clear caches), zeroes the checkpoint, then replays the whole feed
 * with `live: false` so handlers can suppress non-idempotent side effects.
 */
export const rebuild = <E extends { readonly _tag: string }, EH, R, E2, R2>(
  projection: Projection<E, EH, R>,
  reset: Effect.Effect<void, E2, R2>,
  options?: { readonly batchSize?: number },
): Effect.Effect<CatchupStats, EH | EventDecodeError | E2, EventStore | CheckpointStore | R | R2> =>
  Effect.gen(function* () {
    yield* reset;
    const checkpoints = yield* CheckpointStore;
    yield* checkpoints.save(projection.name, 0n);
    return yield* catchupWith(projection, false, options?.batchSize ?? 100);
  });
