import { ConcurrencyConflict } from "@structure-ai/domain";
import { Context, Effect, Either, Layer, Option, Ref, Stream, SynchronizedRef } from "effect";
import { CheckpointStore } from "./CheckpointStore.js";
import { type AppendResult, EventStore, type StoredEvent } from "./EventStore.js";
import {
  type HistoryImportBatch,
  HistoryImporter,
  type HistoryImportResult,
  historyImportConflict,
  historyImportResumeToken,
  historyImportTarget,
  prepareHistoryImportBatch,
  validateHistoryImportContinuation,
} from "./HistoryImport.js";
import { Inbox, Outbox, type OutboxEntry } from "./Outbox.js";
import { type Snapshot, SnapshotStore } from "./SnapshotStore.js";

/**
 * Splits a stream name into the conflict's entity/id at the first `-`
 * (stream categories must not contain `-`; see `EventStoreService.append`).
 */
const conflictIdentity = (streamName: string): { entity: string; id: string } => {
  const separator = streamName.indexOf("-");
  return separator === -1
    ? { entity: streamName, id: streamName }
    : { entity: streamName.slice(0, separator), id: streamName.slice(separator + 1) };
};

interface EventStoreState {
  readonly streams: ReadonlyMap<string, ReadonlyArray<StoredEvent>>;
  readonly all: ReadonlyArray<StoredEvent>;
  readonly imports: ReadonlyMap<string, HistoryImportSession>;
  readonly importBatches: ReadonlyMap<string, HistoryImportBatchRecord>;
}

interface HistoryImportSession {
  readonly resumeToken: string;
  readonly lastPosition: bigint;
  readonly complete: boolean;
}

interface HistoryImportBatchRecord {
  readonly checksum: string;
  readonly previousToken: string | undefined;
  readonly complete: boolean;
  readonly result: HistoryImportResult;
}

const importBatchKey = (batch: HistoryImportBatch): string =>
  `${batch.importId.length}:${batch.importId}${batch.batchId}`;

/**
 * In-memory `EventStore`. Appends run inside a single atomic `Ref.modify`,
 * so the per-stream version check and the global position assignment are
 * linearizable: under concurrent appends to one stream exactly one writer
 * wins and the loser gets a `ConcurrencyConflict`. Reads see a consistent
 * snapshot taken when the stream is subscribed.
 */
export const InMemoryEventStore: Layer.Layer<EventStore | HistoryImporter> = Layer.effectContext(
  Effect.gen(function* () {
    const ref = yield* SynchronizedRef.make<EventStoreState>({
      streams: new Map(),
      all: [],
      imports: new Map(),
      importBatches: new Map(),
    });
    const eventStore = EventStore.of({
      append: (streamName, expectedVersion, events) =>
        Ref.modify(
          ref,
          (state): readonly [Either.Either<AppendResult, ConcurrencyConflict>, EventStoreState] => {
            const existing = state.streams.get(streamName) ?? [];
            const actualVersion = existing.length;
            if (actualVersion !== expectedVersion) {
              const { entity, id } = conflictIdentity(streamName);
              return [
                Either.left(
                  new ConcurrencyConflict({ entity, id, expectedVersion, actualVersion }),
                ),
                state,
              ];
            }
            if (events.length === 0) {
              return [
                Either.right({ firstVersion: actualVersion, lastVersion: actualVersion }),
                state,
              ];
            }
            const basePosition = BigInt(state.all.length);
            const stored = events.map(
              (event, index): StoredEvent => ({
                position: basePosition + BigInt(index + 1),
                streamName,
                version: actualVersion + index + 1,
                type: event.type,
                schemaVersion: event.schemaVersion,
                payload: event.payload,
                metadata: event.metadata,
              }),
            );
            const streams = new Map(state.streams);
            streams.set(streamName, [...existing, ...stored]);
            return [
              Either.right({
                firstVersion: actualVersion + 1,
                lastVersion: actualVersion + events.length,
              }),
              { ...state, streams, all: [...state.all, ...stored] },
            ];
          },
        ).pipe(Effect.flatten),
      read: (streamName, options) =>
        Stream.unwrap(
          Effect.map(Ref.get(ref), (state) => {
            const fromVersion = options?.fromVersion ?? 1;
            const events = (state.streams.get(streamName) ?? []).filter(
              (event) => event.version >= fromVersion,
            );
            return Stream.fromIterable(events);
          }),
        ),
      readAll: (options) =>
        Stream.unwrap(
          Effect.map(Ref.get(ref), (state) => {
            const fromPosition = options?.fromPosition ?? 1n;
            let events = state.all.filter((event) => event.position >= fromPosition);
            if (options?.batchSize !== undefined) {
              events = events.slice(0, options.batchSize);
            }
            return Stream.fromIterable(events);
          }),
        ),
    });
    const historyImporter = HistoryImporter.of({
      importBatch: (batch, decoder) =>
        Effect.gen(function* () {
          yield* prepareHistoryImportBatch(batch, decoder);
          const lastEvent = batch.events.at(-1);
          if (lastEvent === undefined) return yield* Effect.die("validated batch has no events");
          const token = yield* historyImportResumeToken(batch, lastEvent.position);
          return yield* SynchronizedRef.modifyEffect(ref, (state) =>
            Effect.gen(function* () {
              const key = importBatchKey(batch);
              const recorded = state.importBatches.get(key);
              const complete = batch.complete ?? false;
              if (recorded !== undefined) {
                if (
                  recorded.checksum !== batch.checksum ||
                  recorded.previousToken !== batch.resumeToken ||
                  recorded.complete !== complete
                ) {
                  return yield* historyImportConflict(
                    "divergent-batch",
                    `batch ${batch.batchId} was already committed with different content or state`,
                  );
                }
                return [{ ...recorded.result, status: "unchanged" }, state] as const;
              }

              const session = state.imports.get(batch.importId);
              if (session === undefined) {
                if (state.all.length > 0) {
                  return yield* historyImportConflict(
                    "target-not-empty",
                    "a new import requires an empty event store",
                  );
                }
                if (batch.resumeToken !== undefined) {
                  return yield* historyImportConflict(
                    "resume-token-mismatch",
                    "the first batch must not include a resume token",
                  );
                }
              } else {
                if (session.complete) {
                  return yield* historyImportConflict(
                    "import-complete",
                    `import ${batch.importId} is already complete`,
                  );
                }
                if (batch.resumeToken !== session.resumeToken) {
                  return yield* historyImportConflict(
                    "resume-token-mismatch",
                    `batch ${batch.batchId} does not resume the latest committed batch`,
                  );
                }
                if (state.all.at(-1)?.position !== session.lastPosition) {
                  return yield* historyImportConflict(
                    "target-not-empty",
                    "the target changed after the latest import batch",
                  );
                }
              }

              yield* validateHistoryImportContinuation(
                batch.events,
                historyImportTarget(state.all),
              );
              const streams = new Map(state.streams);
              for (const event of batch.events) {
                streams.set(event.streamName, [...(streams.get(event.streamName) ?? []), event]);
              }
              const result: HistoryImportResult = {
                status: "imported",
                importedCount: batch.events.length,
                lastPosition: lastEvent.position,
                resumeToken: token,
                complete,
              };
              const imports = new Map(state.imports).set(batch.importId, {
                resumeToken: token,
                lastPosition: lastEvent.position,
                complete,
              });
              const importBatches = new Map(state.importBatches).set(key, {
                checksum: batch.checksum,
                previousToken: batch.resumeToken,
                complete,
                result,
              });
              return [
                result,
                {
                  streams,
                  all: [...state.all, ...batch.events],
                  imports,
                  importBatches,
                },
              ] as const;
            }),
          );
        }),
    });
    return Context.make(EventStore, eventStore).pipe(Context.add(HistoryImporter, historyImporter));
  }),
);

/** In-memory `SnapshotStore`: keeps the latest snapshot per stream. */
export const InMemorySnapshotStore: Layer.Layer<SnapshotStore> = Layer.effect(
  SnapshotStore,
  Effect.gen(function* () {
    const ref = yield* Ref.make<ReadonlyMap<string, Snapshot>>(new Map());
    return SnapshotStore.of({
      load: (streamName) =>
        Effect.map(Ref.get(ref), (snapshots) => Option.fromNullable(snapshots.get(streamName))),
      save: (streamName, snapshot) =>
        Ref.update(ref, (snapshots) => new Map(snapshots).set(streamName, snapshot)),
    });
  }),
);

/** In-memory `CheckpointStore`: unseen consumers start at position 0. */
export const InMemoryCheckpointStore: Layer.Layer<CheckpointStore> = Layer.effect(
  CheckpointStore,
  Effect.gen(function* () {
    const ref = yield* Ref.make<ReadonlyMap<string, bigint>>(new Map());
    return CheckpointStore.of({
      load: (name) => Effect.map(Ref.get(ref), (checkpoints) => checkpoints.get(name) ?? 0n),
      save: (name, position) =>
        Ref.update(ref, (checkpoints) => new Map(checkpoints).set(name, position)),
    });
  }),
);

/**
 * In-memory `Outbox`: entries keep enqueue order; `enqueue` is idempotent
 * per message id. Marking an unknown id is a no-op.
 */
export const InMemoryOutbox: Layer.Layer<Outbox> = Layer.effect(
  Outbox,
  Effect.gen(function* () {
    const ref = yield* Ref.make<ReadonlyMap<string, OutboxEntry>>(new Map());
    const update = (id: string, patch: (entry: OutboxEntry) => OutboxEntry): Effect.Effect<void> =>
      Ref.update(ref, (entries) => {
        const entry = entries.get(id);
        if (entry === undefined) {
          return entries;
        }
        return new Map(entries).set(id, patch(entry));
      });
    return Outbox.of({
      enqueue: (messages) =>
        Ref.update(ref, (entries) => {
          const next = new Map(entries);
          for (const message of messages) {
            if (!next.has(message.id)) {
              next.set(message.id, { message, status: "pending", attempts: 0 });
            }
          }
          return next;
        }),
      pending: (limit) =>
        Effect.map(Ref.get(ref), (entries) =>
          [...entries.values()].filter((entry) => entry.status === "pending").slice(0, limit),
        ),
      markPublished: (ids) =>
        Effect.forEach(ids, (id) => update(id, (entry) => ({ ...entry, status: "published" })), {
          discard: true,
        }),
      markFailed: (id, error, attempts) =>
        update(id, (entry) => ({ ...entry, attempts, lastError: error })),
      markDead: (id, error) =>
        update(id, (entry) => ({ ...entry, status: "dead", lastError: error })),
      deadLetters: () =>
        Effect.map(Ref.get(ref), (entries) =>
          [...entries.values()].filter((entry) => entry.status === "dead"),
        ),
    });
  }),
);

/** In-memory `Inbox`: remembers processed (consumerId, messageId) pairs. */
export const InMemoryInbox: Layer.Layer<Inbox> = Layer.effect(
  Inbox,
  Effect.gen(function* () {
    const ref = yield* Ref.make<ReadonlySet<string>>(new Set());
    const key = (consumerId: string, messageId: string): string =>
      `${consumerId}\u0000${messageId}`;
    return Inbox.of({
      seen: (consumerId, messageId) =>
        Effect.map(Ref.get(ref), (keys) => keys.has(key(consumerId, messageId))),
      markProcessed: (consumerId, messageId) =>
        Ref.update(ref, (keys) => new Set(keys).add(key(consumerId, messageId))),
    });
  }),
);

/** Every in-memory adapter merged: a full test/development environment. */
export const InMemoryAll: Layer.Layer<
  EventStore | HistoryImporter | SnapshotStore | CheckpointStore | Outbox | Inbox
> = Layer.mergeAll(
  InMemoryEventStore,
  InMemorySnapshotStore,
  InMemoryCheckpointStore,
  InMemoryOutbox,
  InMemoryInbox,
);
