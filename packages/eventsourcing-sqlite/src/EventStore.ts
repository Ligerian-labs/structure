import * as SqlClient from "@effect/sql/SqlClient";
import { SqlError } from "@effect/sql/SqlError";
import { ConcurrencyConflict, PersistenceError } from "@structure-ai/domain";
import {
  type AppendEvent,
  type AppendResult,
  EventStore,
  type EventStoreService,
  type OutboxMessage,
  readAllPartitions,
  type StoredEvent,
  type StoredEventMetadata,
} from "@structure-ai/eventsourcing";
import { Cause, Effect, Layer, Stream } from "effect";
import { conflictIdentity, encodeJson, toBigInt, toNumber } from "./internal.js";
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

interface EventStoreWithOutbox {
  readonly service: EventStoreService;
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
     * The transactional append: version check, event inserts, and outbox
     * inserts all inside one transaction. The `UNIQUE(stream_name, version)`
     * constraint is the backstop for races the in-transaction check cannot
     * see; its violation is re-mapped to `ConcurrencyConflict` (with the
     * actual version re-read after rollback).
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

    return { service, appendWithOutbox: appendTransaction };
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
): Layer.Layer<EventStore, never, SqlClient.SqlClient> =>
  Layer.effect(
    EventStore,
    Effect.map(make(tableNames(options)), (store) => store.service),
  );
