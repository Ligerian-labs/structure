import { Aggregate, type ConcurrencyConflict, EventMetadata } from "@structure-ai/domain";
import { DateTime, Effect, Option, Predicate, Schema, Stream } from "effect";
import type { EventDecodeError, EventRegistry } from "./codec.js";
import { type AppendEvent, EventStore } from "./EventStore.js";
import { SnapshotStore } from "./SnapshotStore.js";

/**
 * Caller-supplied correlation for a command: `correlationId` ties the
 * resulting events to the workflow that caused them, `causationId` to the
 * direct trigger (usually the id of the message being handled).
 */
export interface CommandMetadata {
  readonly correlationId?: string;
  readonly causationId?: string;
}

/** State and stream version after loading or executing. */
export interface LoadResult<S> {
  readonly state: S;
  readonly version: number;
}

/** Outcome of a command: new state, new stream version, and the events appended. */
export interface ExecuteResult<S, E> {
  readonly state: S;
  readonly version: number;
  readonly events: ReadonlyArray<E>;
}

/**
 * Event-sourced runtime for one aggregate. Streams are named
 * `${aggregate.name}-${id}`; the aggregate name must therefore not
 * contain `-`.
 */
export interface AggregateStoreService<S, C, E, Err> {
  /**
   * Rehydrates the aggregate by folding its stream (starting from the
   * latest snapshot when one is configured and available). An empty stream
   * yields the initial state at version 0.
   */
  readonly load: (id: string) => Effect.Effect<LoadResult<S>, EventDecodeError>;
  /**
   * Loads current state, runs `aggregate.decide`, and appends the emitted
   * events with `expectedVersion` set to the loaded version — a concurrent
   * writer surfaces as `ConcurrencyConflict` and nothing is written.
   * Each event is stamped with `EventMetadata` (fresh eventId, occurredAt
   * from the Effect clock, aggregate identity/version, and the caller's
   * correlation/causation ids).
   */
  readonly execute: (
    id: string,
    command: C,
    metadata?: CommandMetadata,
  ) => Effect.Effect<ExecuteResult<S, E>, Err | ConcurrencyConflict | EventDecodeError>;
  /**
   * Like `execute`, but on `ConcurrencyConflict` reloads and retries the
   * whole command up to `options.times` more times (default 3). Domain
   * errors and decode errors are never retried.
   */
  readonly executeWithRetry: (
    id: string,
    command: C,
    metadata?: CommandMetadata,
    options?: { readonly times?: number },
  ) => Effect.Effect<ExecuteResult<S, E>, Err | ConcurrencyConflict | EventDecodeError>;
}

const encodeMetadata = Schema.encodeSync(EventMetadata);

/**
 * Builds the runtime for `aggregate` on top of the `EventStore` in context.
 *
 * When `options.snapshotEvery` is set and a `SnapshotStore` is present in
 * context, `load` starts from the latest snapshot and `execute` saves a new
 * snapshot once at least `snapshotEvery` events accumulated since the last
 * one. Snapshots store the state raw; after changing the state shape, bump
 * `aggregate.name` to invalidate them (see `SnapshotStore`).
 */
export const make = <S, C, E extends { readonly _tag: string }, Err>(
  aggregate: Aggregate.Aggregate<S, C, E, Err>,
  registry: EventRegistry<E>,
  options?: { readonly snapshotEvery?: number },
): Effect.Effect<AggregateStoreService<S, C, E, Err>, never, EventStore> =>
  Effect.gen(function* () {
    const store = yield* EventStore;
    const snapshots = yield* Effect.serviceOption(SnapshotStore);
    const snapshotEvery = options?.snapshotEvery;
    const snapshotting =
      snapshotEvery !== undefined && Option.isSome(snapshots) ? snapshots.value : undefined;

    const streamName = (id: string): string => `${aggregate.name}-${id}`;

    const loadFrom = (
      id: string,
    ): Effect.Effect<LoadResult<S> & { readonly snapshotVersion: number }, EventDecodeError> =>
      Effect.gen(function* () {
        const name = streamName(id);
        const snapshot =
          snapshotting === undefined ? Option.none() : yield* snapshotting.load(name);
        // Snapshots are written by this runtime for this aggregate; the raw
        // state is trusted to have the aggregate's state shape.
        let state = Option.isSome(snapshot) ? (snapshot.value.state as S) : aggregate.initial;
        let version = Option.isSome(snapshot) ? snapshot.value.version : 0;
        const snapshotVersion = version;
        const events = yield* Stream.runCollect(store.read(name, { fromVersion: version + 1 }));
        for (const stored of events) {
          const event = yield* registry.decode(stored);
          state = aggregate.evolve(state, event);
          version = stored.version;
        }
        return { state, version, snapshotVersion };
      });

    const load = (id: string): Effect.Effect<LoadResult<S>, EventDecodeError> =>
      Effect.map(loadFrom(id), ({ state, version }) => ({ state, version }));

    const execute = (
      id: string,
      command: C,
      metadata?: CommandMetadata,
    ): Effect.Effect<ExecuteResult<S, E>, Err | ConcurrencyConflict | EventDecodeError> =>
      Effect.gen(function* () {
        const name = streamName(id);
        const loaded = yield* loadFrom(id);
        const events = yield* aggregate.decide(loaded.state, command);
        if (events.length === 0) {
          return { state: loaded.state, version: loaded.version, events: [] };
        }
        const occurredAt = yield* DateTime.now;
        const toAppend = yield* Effect.sync(() =>
          events.map((event, index): AppendEvent => {
            const serialized = registry.encode(event);
            return {
              type: serialized.type,
              schemaVersion: serialized.schemaVersion,
              payload: serialized.payload,
              metadata: encodeMetadata(
                new EventMetadata({
                  eventId: crypto.randomUUID(),
                  occurredAt,
                  aggregateName: aggregate.name,
                  aggregateId: id,
                  aggregateVersion: loaded.version + index + 1,
                  ...(metadata?.correlationId !== undefined
                    ? { correlationId: metadata.correlationId }
                    : {}),
                  ...(metadata?.causationId !== undefined
                    ? { causationId: metadata.causationId }
                    : {}),
                }),
              ),
            };
          }),
        );
        const appended = yield* store.append(name, loaded.version, toAppend);
        const state = Aggregate.rehydrate(aggregate, events, loaded.state);
        if (
          snapshotting !== undefined &&
          snapshotEvery !== undefined &&
          appended.lastVersion - loaded.snapshotVersion >= snapshotEvery
        ) {
          yield* snapshotting.save(name, { state, version: appended.lastVersion });
        }
        return { state, version: appended.lastVersion, events };
      });

    const executeWithRetry = (
      id: string,
      command: C,
      metadata?: CommandMetadata,
      retryOptions?: { readonly times?: number },
    ): Effect.Effect<ExecuteResult<S, E>, Err | ConcurrencyConflict | EventDecodeError> =>
      Effect.retry(execute(id, command, metadata), {
        times: retryOptions?.times ?? 3,
        while: (error) => Predicate.isTagged(error, "ConcurrencyConflict"),
      });

    return { load, execute, executeWithRetry };
  });
