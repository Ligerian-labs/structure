import * as SqlClient from "@effect/sql/SqlClient";
import type { SqlError } from "@effect/sql/SqlError";
import { ConcurrencyConflict } from "@structure-ai/domain";
import {
  type AppendEvent,
  type AppendResult,
  EventStore,
  type EventStoreService,
  HistoryImporter,
  type HistoryImporterService,
  type HistoryImportResult,
  type HistoryImportTarget,
  historyImportConflict,
  historyImportResumeToken,
  type OutboxMessage,
  prepareHistoryImportBatch,
  type StoredEvent,
  type StoredEventMetadata,
  validateHistoryImportContinuation,
} from "@structure-ai/eventsourcing";
import { Context, Effect, Layer, Stream } from "effect";
import { conflictIdentity, jsonText, toBigInt, toNumber } from "./internal.js";
import { type AdapterOptions, type TableNames, tableNames } from "./schema.js";

/**
 * First key of the two-key advisory lock that serializes the commit order
 * of appends (`serializeCommitOrder`); the second key is the hash of the
 * events table name. Pick another namespace for any other advisory lock in
 * the same database.
 */
const ADVISORY_NAMESPACE = 0x5f_45_56_54; // "_EVT"

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
  readonly historyImporter: HistoryImporterService;
  readonly appendWithOutbox: (
    streamName: string,
    expectedVersion: number,
    events: ReadonlyArray<AppendEvent>,
    messages: ReadonlyArray<OutboxMessage>,
  ) => Effect.Effect<AppendResult, ConcurrencyConflict | SqlError>;
}

interface HistoryImportRow {
  readonly import_id: string;
  readonly resume_token: string;
  readonly last_position: number | bigint | string;
  readonly complete: boolean;
}

interface HistoryImportBatchRow {
  readonly previous_token: string | null;
  readonly checksum: string;
  readonly complete: boolean;
  readonly imported_count: number | bigint | string;
  readonly last_position: number | bigint | string;
  readonly result_token: string;
}

interface LatestPositionRow {
  readonly position: number | bigint | string | null;
}

interface StreamVersionRow {
  readonly stream_name: string;
  readonly version: number | bigint | string;
}

interface EventIdRow {
  readonly event_id: string;
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
     * Serializes the position-taking phase of concurrent appends so that
     * positions become visible in the order they were drawn.
     *
     * `position` comes from a sequence at INSERT time, inside the append
     * transaction; without this lock two appends can commit in the opposite
     * order of their positions, and a projection that polled in between
     * checkpoints past a position whose transaction had not committed yet —
     * that event is then never delivered to it. A transaction-scoped
     * advisory lock, taken after the version check and before the first
     * insert, is released as part of commit, after the transaction has
     * become visible to new snapshots: whoever draws the next position
     * therefore commits after every lower position is already visible, and
     * a reader that saw position N has seen every committed position below
     * N. Keyed per events table (namespace, hash of the table name) so
     * prefixed table sets never contend with each other or with other
     * advisory-lock users.
     */
    const serializeCommitOrder: Effect.Effect<void, SqlError> = sql`
      SELECT pg_advisory_xact_lock(${ADVISORY_NAMESPACE}, hashtext(${tables.events}))
    `.pipe(Effect.asVoid);

    /**
     * The transactional append: version check, event inserts, and outbox
     * inserts all inside one transaction. Under READ COMMITTED two
     * concurrent appends can both pass the version check; the
     * `UNIQUE(stream_name, version)` constraint then kills the loser, and
     * its violation is re-mapped to `ConcurrencyConflict` (with the actual
     * version re-read after rollback). Appends that insert events hold
     * `serializeCommitOrder` from their first insert to their commit.
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
              yield* serializeCommitOrder;
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

    const historyImporter = HistoryImporter.of({
      importBatch: (batch, decoder) =>
        Effect.gen(function* () {
          const eventIds = yield* prepareHistoryImportBatch(batch, decoder);
          const lastEvent = batch.events.at(-1);
          if (lastEvent === undefined) return yield* Effect.die("validated batch has no events");
          const resultToken = yield* historyImportResumeToken(batch, lastEvent.position);
          const result = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`LOCK TABLE ${sql(tables.events)} IN EXCLUSIVE MODE`;
                yield* sql`LOCK TABLE ${sql(tables.historyImports)} IN EXCLUSIVE MODE`;
                yield* sql`LOCK TABLE ${sql(tables.historyImportBatches)} IN EXCLUSIVE MODE`;

                const recordedRows = yield* sql<HistoryImportBatchRow>`
                  SELECT previous_token, checksum, complete, imported_count,
                         last_position, result_token
                  FROM ${sql(tables.historyImportBatches)}
                  WHERE import_id = ${batch.importId} AND batch_id = ${batch.batchId}
                `;
                const recorded = recordedRows[0];
                const complete = batch.complete ?? false;
                if (recorded !== undefined) {
                  if (
                    recorded.checksum !== batch.checksum ||
                    (recorded.previous_token ?? undefined) !== batch.resumeToken ||
                    recorded.complete !== complete
                  ) {
                    return yield* historyImportConflict(
                      "divergent-batch",
                      `batch ${batch.batchId} was already committed with different content or state`,
                    );
                  }
                  return {
                    status: "unchanged",
                    importedCount: toNumber(recorded.imported_count),
                    lastPosition: toBigInt(recorded.last_position),
                    resumeToken: recorded.result_token,
                    complete: recorded.complete,
                  } satisfies HistoryImportResult;
                }

                const sessionRows = yield* sql<HistoryImportRow>`
                  SELECT import_id, resume_token, last_position, complete
                  FROM ${sql(tables.historyImports)}
                  WHERE import_id = ${batch.importId}
                `;
                const session = sessionRows[0];
                const latestRows = yield* sql<LatestPositionRow>`
                  SELECT max(position) AS position
                  FROM ${sql(tables.events)}
                `;
                const streamNames = [...new Set(batch.events.map((event) => event.streamName))];
                const versionRows = yield* sql<StreamVersionRow>`
                  SELECT stream_name, max(version) AS version
                  FROM ${sql(tables.events)}
                  WHERE stream_name IN ${sql.in(streamNames)}
                  GROUP BY stream_name
                `;
                const duplicateRows = yield* sql<EventIdRow>`
                  SELECT metadata->>'eventId' AS event_id
                  FROM ${sql(tables.events)}
                  WHERE metadata->>'eventId' IN ${sql.in([...eventIds])}
                `;
                const target: HistoryImportTarget = {
                  lastPosition: toBigInt(latestRows[0]?.position ?? 0),
                  streamVersions: new Map(
                    versionRows.map((row) => [row.stream_name, toNumber(row.version)]),
                  ),
                  eventIds: new Set(duplicateRows.map((row) => row.event_id)),
                };

                if (session === undefined) {
                  if (target.lastPosition > 0n) {
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
                  if (batch.resumeToken !== session.resume_token) {
                    return yield* historyImportConflict(
                      "resume-token-mismatch",
                      `batch ${batch.batchId} does not resume the latest committed batch`,
                    );
                  }
                  if (target.lastPosition !== toBigInt(session.last_position)) {
                    return yield* historyImportConflict(
                      "target-not-empty",
                      "the target changed after the latest import batch",
                    );
                  }
                }

                yield* validateHistoryImportContinuation(batch.events, target);
                yield* Effect.forEach(
                  batch.events,
                  (event) => sql`
                    INSERT INTO ${sql(tables.events)}
                      (position, stream_name, version, type, schema_version, payload, metadata)
                    VALUES
                      (${String(event.position)}, ${event.streamName}, ${event.version}, ${event.type},
                       ${event.schemaVersion}, ${jsonText(event.payload)}::jsonb,
                       ${jsonText(event.metadata)}::jsonb)
                  `,
                  { discard: true },
                );
                yield* sql`
                  INSERT INTO ${sql(tables.historyImports)}
                    (import_id, resume_token, last_position, complete)
                  VALUES
                    (${batch.importId}, ${resultToken}, ${String(lastEvent.position)}, ${complete})
                  ON CONFLICT (import_id) DO UPDATE SET
                    resume_token = EXCLUDED.resume_token,
                    last_position = EXCLUDED.last_position,
                    complete = EXCLUDED.complete
                `;
                yield* sql`
                  INSERT INTO ${sql(tables.historyImportBatches)}
                    (import_id, batch_id, previous_token, checksum, complete,
                     imported_count, last_position, result_token)
                  VALUES
                    (${batch.importId}, ${batch.batchId}, ${batch.resumeToken ?? null},
                     ${batch.checksum}, ${complete}, ${batch.events.length},
                     ${String(lastEvent.position)}, ${resultToken})
                `;
                return {
                  status: "imported",
                  importedCount: batch.events.length,
                  lastPosition: lastEvent.position,
                  resumeToken: resultToken,
                  complete,
                } satisfies HistoryImportResult;
              }),
            )
            .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
          yield* sql`
            SELECT setval(
              pg_get_serial_sequence(format('%I', ${tables.events}::text), 'position'),
              (SELECT max(position) FROM ${sql(tables.events)}),
              true
            )
          `.pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
          return result;
        }),
    });

    return { service, historyImporter, appendWithOutbox: appendTransaction };
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
): Layer.Layer<EventStore | HistoryImporter, never, SqlClient.SqlClient> =>
  Layer.effectContext(
    Effect.map(make(tableNames(options)), (store) =>
      Context.make(EventStore, store.service).pipe(
        Context.add(HistoryImporter, store.historyImporter),
      ),
    ),
  );
