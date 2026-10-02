import { ConcurrencyConflict } from "@structure-ai/domain";
import {
  Clock,
  Context,
  Duration,
  Effect,
  Either,
  Layer,
  Option,
  Ref,
  Stream,
  SynchronizedRef,
} from "effect";
import { CheckpointStore } from "./CheckpointStore.js";
import {
  type AppendResult,
  EventStore,
  readAllPartitions,
  type StoredEvent,
} from "./EventStore.js";
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
import { Inbox, Outbox, type OutboxClaim, type OutboxEntry } from "./Outbox.js";
import { type Snapshot, SnapshotStore } from "./SnapshotStore.js";
import {
  erasedTombstone,
  prepareStreamErasure,
  StreamEraser,
  type StreamErasureResult,
  streamErasureConflict,
} from "./StreamErasure.js";

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

/**
 * Internal state of `InMemoryEventStore`. The containers are deliberately
 * mutable: mutation happens only inside the store's `Ref` critical sections
 * (plain `Ref.modify` and `SynchronizedRef.modifyEffect` both run their
 * callback exactly once while holding the ref's lock), and every reader
 * escapes through `filter`, which copies. No code may mutate these fields
 * outside a critical section or hand out a live container.
 */
interface ErasedStreamRecord {
  readonly lastVersion: number;
  readonly erasedAt: string;
  readonly reason: string;
}

interface EventStoreState {
  readonly streams: Map<string, Array<StoredEvent>>;
  readonly all: Array<StoredEvent>;
  readonly imports: Map<string, HistoryImportSession>;
  readonly importBatches: Map<string, HistoryImportBatchRecord>;
  /** Erasure ledger: a stream in this map is pinned — every append fails. */
  readonly erased: Map<string, ErasedStreamRecord>;
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
export const InMemoryEventStore: Layer.Layer<EventStore | HistoryImporter | StreamEraser> =
  Layer.effectContext(
    Effect.gen(function* () {
      const ref = yield* SynchronizedRef.make<EventStoreState>({
        streams: new Map(),
        all: [],
        imports: new Map(),
        importBatches: new Map(),
        erased: new Map(),
      });
      const eventStore = EventStore.of({
        append: (streamName, expectedVersion, events) =>
          Ref.modify(
            ref,
            (
              state,
            ): readonly [Either.Either<AppendResult, ConcurrencyConflict>, EventStoreState] => {
              const erasedRecord = state.erased.get(streamName);
              if (erasedRecord !== undefined) {
                const { entity, id } = conflictIdentity(streamName);
                return [
                  Either.left(
                    new ConcurrencyConflict({
                      entity,
                      id,
                      expectedVersion,
                      actualVersion: erasedRecord.lastVersion,
                    }),
                  ),
                  state,
                ];
              }
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
              // In-place mutation: this callback runs exactly once while the
              // ref's lock is held, so no reader can observe an intermediate
              // state. Copying `all` and the per-stream array per append made
              // repeated single-event appends quadratic (see issue #89).
              const stream = state.streams.get(streamName);
              if (stream === undefined) {
                state.streams.set(streamName, stored);
              } else {
                for (const event of stored) stream.push(event);
              }
              for (const event of stored) state.all.push(event);
              return [
                Either.right({
                  firstVersion: actualVersion + 1,
                  lastVersion: actualVersion + events.length,
                }),
                state,
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
              const partitions = readAllPartitions(options?.partition);
              let events = state.all.filter(
                (event) =>
                  event.position >= fromPosition &&
                  (partitions === undefined ||
                    (event.metadata.partition !== undefined &&
                      partitions.includes(event.metadata.partition))),
              );
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
                if (state.erased.size > 0) {
                  return yield* historyImportConflict(
                    "target-not-empty",
                    "a target with erased streams cannot be imported into",
                  );
                }
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
                    erased: state.erased,
                  },
                ] as const;
              }),
            );
          }),
      });
      const streamEraser = StreamEraser.of({
        eraseStream: (request) =>
          Effect.gen(function* () {
            yield* prepareStreamErasure(request);
            const snapshots = yield* Effect.serviceOption(SnapshotStore);
            const erasedAt = new Date().toISOString();
            const result = yield* SynchronizedRef.modifyEffect(ref, (state) => {
              const recorded = state.erased.get(request.streamName);
              if (recorded !== undefined) {
                if (request.expectedVersion !== recorded.lastVersion) {
                  return Effect.fail(
                    streamErasureConflict(
                      request.streamName,
                      request.expectedVersion,
                      recorded.lastVersion,
                    ),
                  );
                }
                return Effect.succeed([
                  {
                    erasedEvents: 0,
                    lastVersion: recorded.lastVersion,
                    erasedAt: recorded.erasedAt,
                    reason: recorded.reason,
                  } as const,
                  state,
                ] as const);
              }
              const existing = state.streams.get(request.streamName) ?? [];
              const actualVersion = existing.length;
              if (actualVersion !== request.expectedVersion) {
                return Effect.fail(
                  streamErasureConflict(request.streamName, request.expectedVersion, actualVersion),
                );
              }
              const tombstones = existing.map((event) => {
                const tombstone = erasedTombstone(request.streamName, event.version, erasedAt);
                return {
                  position: event.position,
                  streamName: event.streamName,
                  version: event.version,
                  type: tombstone.type,
                  schemaVersion: tombstone.schemaVersion,
                  payload: tombstone.payload,
                  metadata: tombstone.metadata,
                } satisfies StoredEvent;
              });
              const byVersion = new Map(tombstones.map((event) => [event.version, event]));
              const streams = new Map(state.streams).set(request.streamName, tombstones);
              const all = state.all.map((event) => {
                if (event.streamName !== request.streamName) return event;
                const replacement = byVersion.get(event.version);
                return replacement === undefined ? event : replacement;
              });
              const erased = new Map(state.erased).set(request.streamName, {
                lastVersion: actualVersion,
                erasedAt,
                reason: request.reason,
              });
              return Effect.succeed([
                {
                  erasedEvents: existing.length,
                  lastVersion: actualVersion,
                  erasedAt,
                  reason: request.reason,
                } as const,
                { ...state, streams, all, erased },
              ] as const);
            });
            // Snapshot removal rides along when a SnapshotStore (with
            // `remove`) is in context — InMemoryAll provides one. Unlike the
            // SQL adapters (one transaction), this is best-effort after the
            // ledger write; re-erasure also re-removes.
            if (Option.isSome(snapshots) && snapshots.value.remove !== undefined) {
              yield* snapshots.value.remove(request.streamName);
            }
            return result satisfies StreamErasureResult;
          }),
      });
      return Context.make(EventStore, eventStore)
        .pipe(Context.add(HistoryImporter, historyImporter))
        .pipe(Context.add(StreamEraser, streamEraser));
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
      remove: (streamName) =>
        Ref.update(ref, (snapshots) => {
          if (!snapshots.has(streamName)) return snapshots;
          const next = new Map(snapshots);
          next.delete(streamName);
          return next;
        }),
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
 * per message id. Marking an unknown id is a no-op. `pending` returns only
 * entries whose `availableAt` (set at enqueue or by `markFailed`) has
 * elapsed and whose claim lease (if any) has lapsed, mirroring the SQL
 * adapters' due filter and lease semantics.
 */
export const InMemoryOutbox: Layer.Layer<Outbox> = Layer.effect(
  Outbox,
  Effect.gen(function* () {
    /** Delivery ownership: the claim's token and when its lease lapses. */
    interface ClaimState {
      readonly token: string;
      readonly leaseUntil: number;
    }
    interface OutboxState {
      readonly entries: ReadonlyMap<string, OutboxEntry>;
      /** Live claims by entry id — cleared on settle or lease expiry. */
      readonly claims: ReadonlyMap<string, ClaimState>;
      /** Monotonic counter for readable claim tokens. */
      readonly nextToken: number;
    }
    const ref = yield* Ref.make<OutboxState>({
      entries: new Map(),
      claims: new Map(),
      nextToken: 0,
    });
    const update = (id: string, patch: (entry: OutboxEntry) => OutboxEntry): Effect.Effect<void> =>
      Ref.update(ref, (state) => {
        const entry = state.entries.get(id);
        if (entry === undefined) {
          return state;
        }
        return {
          ...state,
          entries: new Map(state.entries).set(id, patch(entry)),
          claims: withoutClaim(state.claims, id),
        };
      });
    const due = (entry: OutboxEntry, now: number): boolean =>
      entry.availableAt === undefined || entry.availableAt <= now;
    /** A claimed entry is deliverable once its lease has lapsed. */
    const leaseLapsed = (state: OutboxState, id: string, now: number): boolean => {
      const claim = state.claims.get(id);
      return claim === undefined || claim.leaseUntil <= now;
    };
    /** The claim map without `id` (a settled entry releases its claim). */
    const withoutClaim = (
      claims: ReadonlyMap<string, ClaimState>,
      id: string,
    ): ReadonlyMap<string, ClaimState> => {
      if (!claims.has(id)) return claims;
      const next = new Map(claims);
      next.delete(id);
      return next;
    };
    return Outbox.of({
      enqueue: (messages) =>
        Ref.update(ref, (state) => {
          const next = new Map(state.entries);
          for (const message of messages) {
            if (!next.has(message.id)) {
              const entry: OutboxEntry = { message, status: "pending", attempts: 0 };
              next.set(
                message.id,
                message.availableAt === undefined
                  ? entry
                  : { ...entry, availableAt: message.availableAt },
              );
            }
          }
          return { ...state, entries: next };
        }),
      pending: (limit) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) =>
          Effect.map(Ref.get(ref), (state) =>
            [...state.entries.values()]
              .filter(
                (entry) =>
                  entry.status === "pending" &&
                  due(entry, now) &&
                  leaseLapsed(state, entry.message.id, now),
              )
              .slice(0, limit),
          ),
        ),
      claim: (limit, lease) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) =>
          Ref.modify(ref, (state): readonly [OutboxClaim, OutboxState] => {
            const leaseUntil = now + Duration.toMillis(lease);
            const token = `mem-${state.nextToken}`;
            const claimed: Array<OutboxEntry> = [];
            const claims = new Map(state.claims);
            for (const entry of state.entries.values()) {
              if (claimed.length >= limit) break;
              if (entry.status !== "pending") continue;
              if (!due(entry, now)) continue;
              if (!leaseLapsed(state, entry.message.id, now)) continue;
              claimed.push(entry);
              claims.set(entry.message.id, { token, leaseUntil });
            }
            const next: OutboxState =
              claimed.length > 0 ? { ...state, claims, nextToken: state.nextToken + 1 } : state;
            return [{ entries: claimed, token, leaseUntil }, next];
          }),
        ),
      markPublished: (ids, claim) =>
        Ref.modify(ref, (state): readonly [boolean, OutboxState] => {
          let applied = false;
          let next = state;
          for (const id of ids) {
            const entry = state.entries.get(id);
            if (entry === undefined) continue;
            const held = owns(state, id, claim);
            if (!held) continue;
            applied = true;
            next = {
              ...next,
              entries: new Map(next.entries).set(id, { ...entry, status: "published" }),
              claims: withoutClaim(next.claims, id),
            };
          }
          return [applied, next];
        }),
      markFailed: (id, error, attempts, retryAt, claim) =>
        Ref.modify(ref, (state): readonly [boolean, OutboxState] => {
          const entry = state.entries.get(id);
          if (entry === undefined || !owns(state, id, claim)) {
            return [false, state];
          }
          const { availableAt: _previous, ...rest } = entry;
          const failed =
            retryAt === undefined
              ? { ...rest, attempts, lastError: error }
              : { ...rest, attempts, lastError: error, availableAt: retryAt };
          return [true, { ...state, entries: new Map(state.entries).set(id, failed) }];
        }),
      markDead: (id, error, claim) =>
        Ref.modify(ref, (state): readonly [boolean, OutboxState] => {
          const entry = state.entries.get(id);
          if (entry === undefined || !owns(state, id, claim)) {
            return [false, state];
          }
          return [
            true,
            {
              ...state,
              entries: new Map(state.entries).set(id, {
                ...entry,
                status: "dead",
                lastError: error,
              }),
              claims: withoutClaim(state.claims, id),
            },
          ];
        }),
      replay: (ids) =>
        Effect.forEach(
          ids,
          (id) =>
            update(id, (entry) => {
              if (entry.status !== "dead") {
                return entry;
              }
              const { availableAt: _availableAt, lastError: _lastError, ...rest } = entry;
              return { ...rest, status: "pending" as const, attempts: 0 };
            }),
          { discard: true },
        ),
      deadLetters: () =>
        Effect.map(Ref.get(ref), (state) =>
          [...state.entries.values()].filter((entry) => entry.status === "dead"),
        ),
    });
    /** Whether `id` may be settled under `claim` (no token = unfenced single writer). */
    function owns(state: OutboxState, id: string, claim: string | undefined): boolean {
      if (claim === undefined) return true;
      const held = state.claims.get(id);
      return held !== undefined && held.token === claim;
    }
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
  EventStore | HistoryImporter | StreamEraser | SnapshotStore | CheckpointStore | Outbox | Inbox
> = Layer.mergeAll(
  InMemoryEventStore,
  InMemorySnapshotStore,
  InMemoryCheckpointStore,
  InMemoryOutbox,
  InMemoryInbox,
);
