import * as SqlClient from "@effect/sql/SqlClient";
import type { SqlError } from "@effect/sql/SqlError";
import { ConcurrencyConflict } from "@structure/domain";
import {
  type AppendEvent,
  type AppendResult,
  EventStore,
  type EventStoreService,
  type OutboxMessage,
  type StoredEvent,
  type StoredEventMetadata,
} from "@structure/eventsourcing";
import { Effect, Layer, Stream } from "effect";
import { conflictIdentity, jsonText, toBigInt, toNumber } from "./internal.js";
import { type AdapterOptions, type TableNames, tableNames } from "./schema.js";

interface EventRow {
  readonly position: number | bigint | string;
  readonly stream_name: string;
  readonly version: number | bigint | string;
  readonly type: string;
  readonly schema_version: number | bigint | string;
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
 * Whether a `SqlError` is Postgres' unique-constraint violation (23505) on
 * the events table — the backstop that turns a lost append race into a
 * `ConcurrencyConflict`.
 */
const isEventsVersionConflict = (error: SqlError, eventsTable: string): boolean => {
  const cause = error.cause;
  if (typeof cause !== "object" || cause === null) {
    return false;
  }
  const code = "code" in cause ? cause.code : undefined;
  const table = "table" in cause ? cause.table : undefined;
  return code === "23505" && table === eventsTable;
};

interface EventStoreWithOutbox {
  readonly service: EventStoreService;
  readonly appendWithOutbox: (
    streamName: string,
    expectedVersion: number,
    events: ReadonlyArray<AppendEvent>,
    messages: ReadonlyArray<OutboxMessage>,
  ) => Effect.Effect<AppendResult, ConcurrencyConflict | SqlError>;
}

const make = (
  tables: TableNames,
): Effect.Effect<EventStoreWithOutbox, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const currentVersion = (streamName: string): Effect.Effect<number, SqlError> =>
      Effect.map(
        sql<{ readonly version: number | bigint | string | null }>`
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
    ): Effect.Effect<void, SqlError> =>
      Effect.forEach(
        events,
        (event, index) => sql`
          INSERT INTO ${sql(tables.events)}
            (stream_name, version, type, schema_version, payload, metadata)
          VALUES
            (${streamName}, ${expectedVersion + index + 1}, ${event.type},
             ${event.schemaVersion}, ${jsonText(event.payload)}::jsonb,
             ${jsonText(event.metadata)}::jsonb)
        `,
        { discard: true },
      );

    // Plain inserts on purpose: inside the append transaction a duplicate
    // message id must fail the whole transaction (unlike `Outbox.enqueue`,
    // which is idempotent), so events and messages commit or roll back
    // together.
    const insertMessages = (
      messages: ReadonlyArray<OutboxMessage>,
    ): Effect.Effect<void, SqlError> =>
      Effect.forEach(
        messages,
        (message) => sql`
          INSERT INTO ${sql(tables.outbox)} (id, topic, payload, metadata, status, attempts)
          VALUES (${message.id}, ${message.topic}, ${jsonText(message.payload)}::jsonb,
                  ${jsonText(message.metadata)}::jsonb, 'pending', 0)
        `,
        { discard: true },
      );

    /**
     * The transactional append: version check, event inserts, and outbox
     * inserts all inside one transaction. Under READ COMMITTED two
     * concurrent appends can both pass the version check; the
     * `UNIQUE(stream_name, version)` constraint then kills the loser, and
     * its violation is re-mapped to `ConcurrencyConflict` (with the actual
     * version re-read after rollback).
     */
    const appendTransaction = (
      streamName: string,
      expectedVersion: number,
      events: ReadonlyArray<AppendEvent>,
      messages: ReadonlyArray<OutboxMessage>,
    ): Effect.Effect<AppendResult, ConcurrencyConflict | SqlError> =>
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
          Effect.catchTag(
            "SqlError",
            (error): Effect.Effect<never, ConcurrencyConflict | SqlError> =>
              isEventsVersionConflict(error, tables.events)
                ? Effect.flatMap(Effect.orDie(currentVersion(streamName)), (actualVersion) =>
                    Effect.fail(conflict(streamName, expectedVersion, actualVersion)),
                  )
                : Effect.fail(error),
          ),
        );

    // `::text` so payload/metadata always arrive as JSON text regardless of
    // the driver's jsonb parsing, and get decoded in one place.
    const selectEvents = sql`
      SELECT position, stream_name, version, type, schema_version,
             payload::text AS payload, metadata::text AS metadata
    `;

    const service = EventStore.of({
      append: (streamName, expectedVersion, events) =>
        appendTransaction(streamName, expectedVersion, events, []).pipe(
          Effect.catchTag("SqlError", (error) => Effect.die(error)),
        ),
      read: (streamName, options) =>
        Stream.unwrap(
          sql<EventRow>`
            ${selectEvents}
            FROM ${sql(tables.events)}
            WHERE stream_name = ${streamName} AND version >= ${options?.fromVersion ?? 1}
            ORDER BY version ASC
          `.pipe(
            Effect.orDie,
            Effect.map((rows) => Stream.fromIterable(rows.map(decodeEvent))),
          ),
        ),
      readAll: (options) => {
        const fromPosition = String(options?.fromPosition ?? 1n);
        const batchSize = options?.batchSize;
        const query =
          batchSize === undefined
            ? sql<EventRow>`
                ${selectEvents}
                FROM ${sql(tables.events)}
                WHERE position >= ${fromPosition}
                ORDER BY position ASC
              `
            : sql<EventRow>`
                ${selectEvents}
                FROM ${sql(tables.events)}
                WHERE position >= ${fromPosition}
                ORDER BY position ASC
                LIMIT ${batchSize}
              `;
        return Stream.unwrap(
          query.pipe(
            Effect.orDie,
            Effect.map((rows) => Stream.fromIterable(rows.map(decodeEvent))),
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
): Effect.Effect<AppendResult, ConcurrencyConflict | SqlError, SqlClient.SqlClient> =>
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
