import * as SqlClient from "@effect/sql/SqlClient";
import { SqlError } from "@effect/sql/SqlError";
import { ConcurrencyConflict, PersistenceError } from "@structure-ai/domain";
import {
  type AppendEvent,
  type AppendResult,
  EventStore,
  type EventStoreService,
  erasedTombstone,
  type OutboxMessage,
  prepareStreamErasure,
  readAllPartitions,
  type StoredEvent,
  type StoredEventMetadata,
  StreamEraser,
  type StreamEraserService,
  streamErasureConflict,
} from "@structure-ai/eventsourcing";
import { Cause, Context, Effect, Layer, Stream } from "effect";
import { conflictIdentity, encodeJson, jsonText, toBigInt, toNumber } from "./internal.js";
import { type AdapterOptions, type TableNames, tableNames } from "./schema.js";

interface EventRow {
  readonly position: number | bigint;
  readonly stream_name: string;
  readonly version: number | bigint;
  readonly type: string;
  readonly schema_version: number | bigint;
  readonly payload: string;
  readonly metadata: string;
}

const decodeEvent = (row: EventRow): StoredEvent => ({
  position: toBigInt(row.position),
  streamName: row.stream_name,
  version: toNumber(row.version),
  type: row.type,
  schemaVersion: toNumber(row.schema_version),
  payload: JSON.parse(row.payload) as unknown,
  metadata: JSON.parse(row.metadata) as StoredEventMetadata,
});

/**
 * Whether a `SqlError` is bun:sqlite's unique-constraint violation on the
 * events table's `(stream_name, version)` key — the backstop that turns a
 * lost append race into a `ConcurrencyConflict`.
 */
const isEventsVersionConflict = (error: SqlError, eventsTable: string): boolean => {
  const cause = error.cause;
  if (typeof cause !== "object" || cause === null || !("message" in cause)) {
    return false;
  }
  const message = cause.message;
  return (
    typeof message === "string" &&
    message.includes(`UNIQUE constraint failed: ${eventsTable}.stream_name`)
  );
};

interface ErasedStreamRow {
  readonly stream_name: string;
  readonly last_version: number | bigint;
  readonly erased_at: string;
  readonly reason: string;
}

interface EventStoreWithOutbox {
  readonly service: EventStoreService;
  readonly streamEraser: StreamEraserService;
  readonly appendWithOutbox: (
    streamName: string,
    expectedVersion: number,
    events: ReadonlyArray<AppendEvent>,
    messages: ReadonlyArray<OutboxMessage>,
  ) => Effect.Effect<AppendResult, ConcurrencyConflict | SqlError | PersistenceError>;
}

const make = (
  tables: TableNames,
): Effect.Effect<EventStoreWithOutbox, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const currentVersion = (streamName: string): Effect.Effect<number, SqlError> =>
      Effect.map(
        sql<{ readonly version: number | bigint | null }>`
          SELECT max(version) AS version
          FROM ${sql(tables.events)}
          WHERE stream_name = ${streamName}
        `,
        (rows) => toNumber(rows[0]?.version),
      );

    const conflict = (
      streamName: string,
      expectedVersion: number,
      actualVersion: number,
    ): ConcurrencyConflict => {
      const { entity, id } = conflictIdentity(streamName);
      return new ConcurrencyConflict({ entity, id, expectedVersion, actualVersion });
    };

    const insertEvents = (
      streamName: string,
      expectedVersion: number,
      events: ReadonlyArray<AppendEvent>,
    ): Effect.Effect<void, SqlError | PersistenceError> =>
      Effect.forEach(
        events,
        (event, index) =>
          Effect.gen(function* () {
            return yield* sql`
          INSERT INTO ${sql(tables.events)}
            (stream_name, version, type, schema_version, payload, metadata)
          VALUES
            (${streamName}, ${expectedVersion + index + 1}, ${event.type},
             ${event.schemaVersion}, ${yield* encodeJson(event.payload)}, ${yield* encodeJson(event.metadata)})
        `;
          }),
        { discard: true },
      );

    // Plain inserts on purpose: inside the append transaction a duplicate
    // message id must fail the whole transaction (unlike `Outbox.enqueue`,
    // which is idempotent), so events and messages commit or roll back
    // together.
    const insertMessages = (
      messages: ReadonlyArray<OutboxMessage>,
    ): Effect.Effect<void, SqlError | PersistenceError> =>
      Effect.forEach(
        messages,
        (message) =>
          Effect.gen(function* () {
            return yield* sql`
          INSERT INTO ${sql(tables.outbox)} (id, topic, payload, metadata, status, attempts, available_at)
          VALUES (${message.id}, ${message.topic}, ${yield* encodeJson(message.payload)},
                  ${yield* encodeJson(message.metadata)}, 'pending', 0, ${message.availableAt ?? null})
        `;
          }),
        { discard: true },
      );

    /**
     * The transactional append: ledger check, version check, event inserts,
     * and outbox inserts all inside one transaction. The
     * `UNIQUE(stream_name, version)` constraint is the backstop for races the
     * in-transaction check cannot see; its violation is re-mapped to
     * `ConcurrencyConflict` (with the actual version re-read after rollback).
     * An erased stream is pinned forever: the ledger check fails the append
     * as a `ConcurrencyConflict` at the recorded version.
     */
    const appendTransaction = (
      streamName: string,
      expectedVersion: number,
      events: ReadonlyArray<AppendEvent>,
      messages: ReadonlyArray<OutboxMessage>,
    ): Effect.Effect<AppendResult, ConcurrencyConflict | SqlError | PersistenceError> =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const erasedRows = yield* sql<ErasedStreamRow>`
              SELECT stream_name, last_version, erased_at, reason
              FROM ${sql(tables.erasedStreams)}
              WHERE stream_name = ${streamName}
            `;
            const erased = erasedRows[0];
            if (erased !== undefined) {
              return yield* conflict(streamName, expectedVersion, toNumber(erased.last_version));
            }
            const actualVersion = yield* currentVersion(streamName);
            if (actualVersion !== expectedVersion) {
              return yield* conflict(streamName, expectedVersion, actualVersion);
            }
            if (events.length > 0) {
              yield* insertEvents(streamName, expectedVersion, events);
            }
            if (messages.length > 0) {
              yield* insertMessages(messages);
            }
            return events.length === 0
              ? { firstVersion: actualVersion, lastVersion: actualVersion }
              : {
                  firstVersion: expectedVersion + 1,
                  lastVersion: expectedVersion + events.length,
                };
          }),
        )
        .pipe(
          Effect.catchAllCause((cause) => {
            if (
              !Cause.isFailType(cause) ||
              !(cause.error instanceof SqlError) ||
              !isEventsVersionConflict(cause.error, tables.events)
            )
              return Effect.failCause(cause);
            return Effect.flatMap(currentVersion(streamName), (actualVersion) =>
              Effect.fail(conflict(streamName, expectedVersion, actualVersion)),
            );
          }),
        );

    const selectEvents = sql`
      SELECT position, stream_name, version, type, schema_version, payload, metadata
    `;

    const service = EventStore.of({
      append: (streamName, expectedVersion, events) =>
        appendTransaction(streamName, expectedVersion, events, []).pipe(
          Effect.mapError((cause) =>
            cause instanceof SqlError
              ? new PersistenceError({ operation: "EventStore", cause })
              : cause,
          ),
        ),
      read: (streamName, options) =>
        Stream.unwrap(
          sql<EventRow>`
            ${selectEvents}
            FROM ${sql(tables.events)}
            WHERE stream_name = ${streamName} AND version >= ${options?.fromVersion ?? 1}
            ORDER BY version ASC
          `.pipe(
            Effect.mapError((cause) => new PersistenceError({ operation: "EventStore", cause })),
            Effect.flatMap((rows) =>
              Effect.try({
                try: () => Stream.fromIterable(rows.map(decodeEvent)),
                catch: (cause) => new PersistenceError({ operation: "events.decode", cause }),
              }),
            ),
          ),
        ),
      readAll: (options) => {
        const fromPosition = options?.fromPosition ?? 1n;
        const batchSize = options?.batchSize;
        const partitions = readAllPartitions(options?.partition);
        // Same expression as the index in `migrate`, so the planner uses
        // it; `IN ()` matches nothing and NULL never matches, so
        // unpartitioned events stay out.
        const partitionFilter =
          partitions === undefined
            ? sql``
            : partitions.length === 0
              ? sql`AND 0`
              : sql`AND json_extract(metadata, '$.partition') IN ${sql.in(partitions)}`;
        const query =
          batchSize === undefined
            ? sql<EventRow>`
                ${selectEvents}
                FROM ${sql(tables.events)}
                WHERE position >= ${fromPosition} ${partitionFilter}
                ORDER BY position ASC
              `
            : sql<EventRow>`
                ${selectEvents}
                FROM ${sql(tables.events)}
                WHERE position >= ${fromPosition} ${partitionFilter}
                ORDER BY position ASC
                LIMIT ${batchSize}
              `;
        return Stream.unwrap(
          query.pipe(
            Effect.mapError((cause) => new PersistenceError({ operation: "EventStore", cause })),
            Effect.flatMap((rows) =>
              Effect.try({
                try: () => Stream.fromIterable(rows.map(decodeEvent)),
                catch: (cause) => new PersistenceError({ operation: "events.decode", cause }),
              }),
            ),
          ),
        );
      },
    });

    const streamEraser = StreamEraser.of({
      eraseStream: (request) =>
        Effect.gen(function* () {
          yield* prepareStreamErasure(request);
          const erasedAt = new Date().toISOString();
          const result = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                const recordedRows = yield* sql<ErasedStreamRow>`
                  SELECT stream_name, last_version, erased_at, reason
                  FROM ${sql(tables.erasedStreams)}
                  WHERE stream_name = ${request.streamName}
                `;
                const recorded = recordedRows[0];
                if (recorded !== undefined) {
                  if (request.expectedVersion !== toNumber(recorded.last_version)) {
                    return yield* streamErasureConflict(
                      request.streamName,
                      request.expectedVersion,
                      toNumber(recorded.last_version),
                    );
                  }
                  return {
                    erasedEvents: 0,
                    lastVersion: toNumber(recorded.last_version),
                    erasedAt: recorded.erased_at,
                    reason: recorded.reason,
                  };
                }
                const actualVersion = yield* currentVersion(request.streamName);
                if (actualVersion !== request.expectedVersion) {
                  return yield* streamErasureConflict(
                    request.streamName,
                    request.expectedVersion,
                    actualVersion,
                  );
                }
                // One UPDATE per version: every tombstone's metadata carries
                // its own version (mirroring the in-memory adapter), so
                // re-reads stay consistent row by row.
                for (let version = 1; version <= request.expectedVersion; version++) {
                  const tombstone = erasedTombstone(request.streamName, version, erasedAt);
                  yield* sql`
                    UPDATE ${sql(tables.events)}
                    SET type = ${tombstone.type},
                        schema_version = ${tombstone.schemaVersion},
                        payload = ${jsonText(tombstone.payload)},
                        metadata = ${jsonText(tombstone.metadata)}
                    WHERE stream_name = ${request.streamName} AND version = ${version}
                  `;
                }
                yield* sql`
                  DELETE FROM ${sql(tables.snapshots)}
                  WHERE stream_name = ${request.streamName}
                `;
                yield* sql`
                  INSERT INTO ${sql(tables.erasedStreams)}
                    (stream_name, last_version, erased_at, reason)
                  VALUES
                    (${request.streamName}, ${request.expectedVersion}, ${erasedAt}, ${request.reason})
                `;
                return {
                  erasedEvents: request.expectedVersion,
                  lastVersion: request.expectedVersion,
                  erasedAt,
                  reason: request.reason,
                };
              }),
            )
            .pipe(
              Effect.catchTag("SqlError", (error) =>
                Effect.fail(new PersistenceError({ operation: "StreamEraser", cause: error })),
              ),
            );
          return result;
        }),
    });

    return { service, streamEraser, appendWithOutbox: appendTransaction };
  });

/**
 * Transactional-outbox append: appends `events` to `streamName` (same
 * optimistic-concurrency contract as `EventStore.append`) and stages
 * `messages` in the outbox, all in ONE transaction — the messages exist iff
 * the events committed. Unlike `Outbox.enqueue`, a duplicate message id
 * fails the whole transaction (as `SqlError`) and nothing is persisted.
 */
export const appendWithOutbox = (
  streamName: string,
  expectedVersion: number,
  events: ReadonlyArray<AppendEvent>,
  messages: ReadonlyArray<OutboxMessage>,
  options?: AdapterOptions,
): Effect.Effect<
  AppendResult,
  ConcurrencyConflict | SqlError | PersistenceError,
  SqlClient.SqlClient
> =>
  Effect.flatMap(make(tableNames(options)), (store) =>
    store.appendWithOutbox(streamName, expectedVersion, events, messages),
  );

/** `EventStore` backed by the `events` table of the `SqlClient` in context. */
export const eventStoreLayer = (
  options?: AdapterOptions,
): Layer.Layer<EventStore | StreamEraser, never, SqlClient.SqlClient> =>
  Layer.effectContext(
    Effect.map(make(tableNames(options)), (store) =>
      Context.make(EventStore, store.service).pipe(Context.add(StreamEraser, store.streamEraser)),
    ),
  );
