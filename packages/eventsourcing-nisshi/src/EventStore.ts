import * as SqlClient from "@effect/sql/SqlClient";
import type { SqlError } from "@effect/sql/SqlError";
import { ConcurrencyConflict } from "@structure-ai/domain";
import {
  type AppendEvent,
  type AppendResult,
  EventStore,
  type EventStoreService,
  type StoredEvent,
  type StoredEventMetadata,
} from "@structure-ai/eventsourcing";
import { Effect, Layer, Stream } from "effect";
import { decodeWireEvent, encodeWireEvent, validateWireEvent } from "./envelope.js";
import { NisshiClient } from "./protocol/client.js";
import { NisshiProduceError } from "./protocol/errors.js";
import { type SidecarOptions, type SidecarTables, sidecarTables } from "./sidecar.js";

/** Options for the Nisshi event-store adapter. */
export interface EventStoreOptions extends SidecarOptions {
  /** Topic holding all streams' events (single partition; default `events`). */
  readonly topic?: string;
  /** Validate the envelope client-side before produce (default: true). */
  readonly schemaValidation?: boolean;
}

/** Whether a `SqlError` is a unique-constraint violation (both dialects). */
const isUniqueViolation = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null || !("cause" in error)) {
    return false;
  }
  const cause: unknown = error.cause;
  if (typeof cause !== "object" || cause === null || !("message" in cause)) {
    return false;
  }
  const message = cause.message;
  return (
    typeof message === "string" &&
    (message.includes("UNIQUE constraint failed") || message.includes("duplicate key value"))
  );
};

const toNumber = (value: number | bigint | string | null | undefined): number =>
  value === null || value === undefined ? 0 : Number(value);

/** Splits a stream name into the conflict's entity/id at the first `-`. */
const conflictIdentity = (streamName: string): { entity: string; id: string } => {
  const separator = streamName.indexOf("-");
  return separator === -1
    ? { entity: streamName, id: streamName }
    : { entity: streamName.slice(0, separator), id: streamName.slice(separator + 1) };
};

const conflict = (
  streamName: string,
  expectedVersion: number,
  actualVersion: number,
): ConcurrencyConflict => {
  const { entity, id } = conflictIdentity(streamName);
  return new ConcurrencyConflict({ entity, id, expectedVersion, actualVersion });
};

const storedEvent = (
  offset: bigint,
  streamName: string,
  envelope: {
    readonly type: string;
    readonly schemaVersion: number;
    readonly version: number;
    readonly payload: unknown;
    readonly metadata: StoredEventMetadata;
  },
): StoredEvent => ({
  position: offset + 1n,
  streamName,
  version: envelope.version,
  type: envelope.type,
  schemaVersion: envelope.schemaVersion,
  payload: envelope.payload,
  metadata: envelope.metadata,
});

const make = (
  options: EventStoreOptions,
): Effect.Effect<EventStoreService, never, SqlClient.SqlClient | NisshiClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const client = yield* NisshiClient;
    const tables: SidecarTables = sidecarTables(options);
    const topic = options.topic ?? "events";
    const validate = options.schemaValidation ?? true;
    const maxBytes = 4 * 1024 * 1024;

    const currentVersion = (streamName: string): Effect.Effect<number, SqlError> =>
      Effect.map(
        sql<{ readonly last_version: number | bigint | string | null }>`
          SELECT last_version FROM ${sql(tables.streams)} WHERE stream_name = ${streamName}
        `,
        (rows) => toNumber(rows[0]?.last_version),
      );

    /**
     * Reserves `expectedVersion + 1 .. + n` for the stream and stages the
     * wire events as pending rows — one transaction. The unique PK on
     * `(stream_name, version)` plus the conditional UPDATE make double
     * reservations impossible; both surface as `ConcurrencyConflict`.
     */
    const reserve = (
      streamName: string,
      expectedVersion: number,
      events: ReadonlyArray<AppendEvent>,
    ): Effect.Effect<AppendResult, ConcurrencyConflict | SqlError> =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            if (events.length === 0) {
              const actual = yield* currentVersion(streamName);
              if (actual !== expectedVersion) {
                return yield* Effect.fail(conflict(streamName, expectedVersion, actual));
              }
              return { firstVersion: expectedVersion, lastVersion: expectedVersion };
            }
            if (expectedVersion === 0) {
              yield* sql`
              INSERT INTO ${sql(tables.streams)} (stream_name, last_version)
              VALUES (${streamName}, ${events.length})
            `;
            } else {
              // Conditional CAS: bumps only when the observed version matches.
              yield* sql`
              UPDATE ${sql(tables.streams)}
              SET last_version = last_version + ${events.length}
              WHERE stream_name = ${streamName} AND last_version = ${expectedVersion}
            `;
            }
            // Authoritative CAS check: re-read after the write attempt.
            const actual = yield* currentVersion(streamName);
            const intended = expectedVersion + events.length;
            if (actual !== intended) {
              return yield* Effect.fail(conflict(streamName, expectedVersion, actual));
            }
            yield* Effect.forEach(
              events,
              (event, index) => {
                const wire = {
                  type: event.type,
                  schemaVersion: event.schemaVersion,
                  version: expectedVersion + index + 1,
                  payload: event.payload,
                  metadata: event.metadata,
                };
                if (validate) {
                  validateWireEvent(wire, streamName);
                }
                return sql`
                INSERT INTO ${sql(tables.pending)} (stream_name, version, topic, record_value)
                VALUES (${streamName}, ${expectedVersion + index + 1}, ${topic}, ${JSON.stringify(wire)})
              `;
              },
              { discard: true },
            );
            return {
              firstVersion: expectedVersion + 1,
              lastVersion: expectedVersion + events.length,
            };
          }),
        )
        .pipe(
          Effect.catchIf(
            (error): error is SqlError => isUniqueViolation(error),
            () =>
              Effect.flatMap(Effect.orDie(currentVersion(streamName)), (actual) =>
                Effect.fail(conflict(streamName, expectedVersion, actual)),
              ),
          ),
        );

    /** Best-effort reservation rollback: only succeeds if nobody built on top. Never masks the original failure. */
    const rollback = (
      streamName: string,
      expectedVersion: number,
      count: number,
    ): Effect.Effect<void> =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
              UPDATE ${sql(tables.streams)}
              SET last_version = ${expectedVersion}
              WHERE stream_name = ${streamName} AND last_version = ${expectedVersion + count}
            `;
            yield* sql`
              DELETE FROM ${sql(tables.pending)}
              WHERE stream_name = ${streamName}
                AND version > ${expectedVersion} AND version <= ${expectedVersion + count}
            `;
          }),
        )
        .pipe(
          Effect.ignore,
          Effect.catchAllDefect(() => Effect.void),
        );

    const append: EventStoreService["append"] = (streamName, expectedVersion, events) =>
      Effect.gen(function* () {
        const result = yield* reserve(streamName, expectedVersion, events).pipe(
          Effect.catchTag("SqlError", (error) => Effect.die(error)),
        );
        if (events.length === 0) {
          return result;
        }
        const records = events.map((event, index) => ({
          key: new TextEncoder().encode(streamName),
          value: encodeWireEvent({
            type: event.type,
            schemaVersion: event.schemaVersion,
            version: expectedVersion + index + 1,
            payload: event.payload,
            metadata: event.metadata,
          }),
        }));
        yield* client.produce(topic, records).pipe(
          Effect.catchAllCause((cause) =>
            Effect.gen(function* () {
              yield* rollback(streamName, expectedVersion, events.length);
              return yield* Effect.die(new NisshiProduceError({ topic, cause }));
            }),
          ),
        );
        // Confirm: events are durable in the topic. A failure here leaves the
        // pending rows for the relay; a re-produce duplicates are tolerated
        // downstream (readers dedupe by version).
        yield* sql`
          DELETE FROM ${sql(tables.pending)}
          WHERE stream_name = ${streamName}
            AND version > ${expectedVersion} AND version <= ${expectedVersion + events.length}
        `.pipe(
          Effect.catchTag("SqlError", (error) =>
            Effect.logWarning(`pending confirm failed: ${error.message}`),
          ),
        );
        return result;
      });

    /** Reads every committed record of the topic from `offset` on. */
    interface TopicRecords {
      readonly records: ReadonlyArray<{
        readonly offset: bigint;
        readonly streamName: string;
        readonly value: Uint8Array;
      }>;
    }
    const readTopic = (fromOffset: bigint): Effect.Effect<TopicRecords> =>
      Effect.gen(function* () {
        const out: { offset: bigint; streamName: string; value: Uint8Array }[] = [];
        let offset = fromOffset;
        for (;;) {
          const page = yield* client.fetch(topic, offset, maxBytes).pipe(Effect.orDie);
          if (page.records.length === 0) {
            return { records: out };
          }
          for (const record of page.records) {
            out.push({
              offset: record.offset,
              streamName: record.key === null ? "" : new TextDecoder().decode(record.key),
              value: record.value,
            });
          }
          const last = page.records[page.records.length - 1];
          if (last === undefined || last.offset + 1n >= page.highWatermark) {
            return { records: out };
          }
          offset = last.offset + 1n;
        }
      });

    const service: EventStoreService = {
      append,
      read: (streamName, readOptions) =>
        Stream.unwrap(
          Effect.map(readTopic(0n), ({ records }) => {
            const fromVersion = readOptions?.fromVersion ?? 1;
            const seen = new Set<number>();
            const events: StoredEvent[] = [];
            for (const record of records) {
              if (record.streamName !== streamName) {
                continue;
              }
              const envelope = decodeWireEvent(record.value, streamName);
              if (envelope.version < fromVersion || seen.has(envelope.version)) {
                continue;
              }
              seen.add(envelope.version);
              events.push(storedEvent(record.offset, streamName, envelope));
            }
            events.sort((a, b) => a.version - b.version);
            return Stream.fromIterable(events);
          }),
        ),
      readAll: (readOptions) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const events: StoredEvent[] = [];
            let offset = (readOptions?.fromPosition ?? 1n) - 1n;
            const limit = readOptions?.batchSize;
            for (;;) {
              if (limit !== undefined && events.length >= limit) {
                break;
              }
              const page = yield* client.fetch(topic, offset, maxBytes).pipe(Effect.orDie);
              if (page.records.length === 0) {
                break;
              }
              for (const record of page.records) {
                const streamName = record.key === null ? "" : new TextDecoder().decode(record.key);
                events.push(
                  storedEvent(record.offset, streamName, decodeWireEvent(record.value, streamName)),
                );
              }
              const last = page.records[page.records.length - 1];
              if (last === undefined || last.offset + 1n >= page.highWatermark) {
                break;
              }
              offset = last.offset + 1n;
            }
            const bounded = limit === undefined ? events : events.slice(0, limit);
            return Stream.fromIterable(bounded);
          }),
        ),
    };
    return service;
  });

/** `EventStore` over Nisshi + the sidecar ledger. */
export const eventStoreLayer = (
  options?: EventStoreOptions,
): Layer.Layer<EventStore, never, SqlClient.SqlClient | NisshiClient> =>
  Layer.effect(EventStore, make(options ?? {}));
