import * as SqlClient from "@effect/sql/SqlClient";
import { SqlError } from "@effect/sql/SqlError";
import { ConcurrencyConflict, PersistenceError } from "@structure-ai/domain";
import {
  type AppendEvent,
  type AppendResult,
  EventStore,
  type EventStoreService,
  erasedTombstone,
  HistoryImporter,
  type HistoryImporterService,
  type HistoryImportResult,
  type HistoryImportTarget,
  historyImportConflict,
  historyImportResumeToken,
  type OutboxMessage,
  prepareHistoryImportBatch,
  prepareStreamErasure,
  readAllPartitions,
  type StoredEvent,
  type StoredEventMetadata,
  StreamEraser,
  type StreamEraserService,
  type StreamErasureResult,
  streamErasureConflict,
  validateHistoryImportContinuation,
} from "@structure-ai/eventsourcing";
import { Cause, Context, Effect, Layer, Stream } from "effect";
import { conflictIdentity, encodeJson, jsonText, toBigInt, toNumber } from "./internal.js";
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
  readonly streamEraser: StreamEraserService;
  readonly appendWithOutbox: (
    streamName: string,
    expectedVersion: number,
    events: ReadonlyArray<AppendEvent>,
    messages: ReadonlyArray<OutboxMessage>,
  ) => Effect.Effect<AppendResult, ConcurrencyConflict | SqlError | PersistenceError>;
}

interface ErasedStreamRow {
  readonly stream_name: string;
  readonly last_version: number | bigint | string;
  readonly erased_at: string;
  readonly reason: string;
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

    /**
     * Serializes append vs erasure for one stream across pool connections.
     * Under READ COMMITTED the ledger check alone cannot stop an erase that
     * commits between an append's check and its inserts: the UNIQUE
     * `(stream_name, version)` backstop never fires because the erased stream
     * keeps its rows. A transaction-scoped advisory lock keyed by the stream
     * name (in an arena private to this table set, so prefixes coexist) makes
     * append-vs-erase linearizable; both paths take it before reading state.
     */
    const lockStream = (streamName: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        SELECT pg_advisory_xact_lock(
          hashtext(${tables.events}), hashtext(${streamName})
        )
      `);

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
             ${event.schemaVersion}, ${yield* encodeJson(event.payload)}::jsonb,
             ${yield* encodeJson(event.metadata)}::jsonb)
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
          VALUES (${message.id}, ${message.topic}, ${yield* encodeJson(message.payload)}::jsonb,
                  ${yield* encodeJson(message.metadata)}::jsonb, 'pending', 0, ${message.availableAt ?? null})
        `;
          }),
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
     * The transactional append: stream lock, ledger check, version check,
     * event inserts, and outbox inserts all inside one transaction. Under
     * READ COMMITTED two concurrent appends can both pass the version check;
     * the `UNIQUE(stream_name, version)` constraint then kills the loser, and
     * its violation is re-mapped to `ConcurrencyConflict` (with the actual
     * version re-read after rollback). An erased stream is pinned forever:
     * the ledger check fails the append as a `ConcurrencyConflict` at the
     * recorded version.
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
            yield* lockStream(streamName);
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

    // `::text` so payload/metadata always arrive as JSON text regardless of
    // the driver's jsonb parsing, and get decoded in one place.
    const selectEvents = sql`
      SELECT position, stream_name, version, type, schema_version,
             payload::text AS payload, metadata::text AS metadata
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
        const fromPosition = String(options?.fromPosition ?? 1n);
        const batchSize = options?.batchSize;
        const partitions = readAllPartitions(options?.partition);
        // The generated `partition` column (schema rev 2) carries the
        // envelope's value; `sql.in` renders `1=0` for an empty list, and
        // NULL never matches, so unpartitioned events stay out.
        const partitionFilter =
          partitions === undefined ? sql`` : sql`AND ${sql.in("partition", partitions)}`;
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

                // A target with erased streams mixes histories: erasure pins
                // its streams and rewrites ids, but a resuming import could
                // still re-insert content past the erased versions (max
                // position is unchanged by erasure). Refuse instead.
                const erasedAny = yield* sql<{ readonly one: number | null }>`
                  SELECT 1 AS one FROM ${sql(tables.erasedStreams)} LIMIT 1
                `;
                if (erasedAny.length > 0) {
                  return yield* historyImportConflict(
                    "target-not-empty",
                    "a target with erased streams cannot be imported into",
                  );
                }

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
                  (event) =>
                    Effect.gen(function* () {
                      return yield* sql`
                    INSERT INTO ${sql(tables.events)}
                      (position, stream_name, version, type, schema_version, payload, metadata)
                    VALUES
                      (${String(event.position)}, ${event.streamName}, ${event.version}, ${event.type},
                       ${event.schemaVersion}, ${yield* encodeJson(event.payload)}::jsonb,
                       ${yield* encodeJson(event.metadata)}::jsonb)
                  `;
                    }),
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
            .pipe(
              Effect.mapError((cause) =>
                cause instanceof SqlError
                  ? new PersistenceError({ operation: "EventStore", cause })
                  : cause,
              ),
            );
          yield* sql`
            SELECT setval(
              pg_get_serial_sequence(format('%I', ${tables.events}::text), 'position'),
              (SELECT max(position) FROM ${sql(tables.events)}),
              true
            )
          `.pipe(
            Effect.mapError((cause) =>
              cause instanceof SqlError
                ? new PersistenceError({ operation: "EventStore", cause })
                : cause,
            ),
          );
          return result;
        }),
    });

    const streamEraser = StreamEraser.of({
      eraseStream: (request) =>
        Effect.gen(function* () {
          yield* prepareStreamErasure(request);
          const erasedAt = new Date().toISOString();
          const result = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                // Same per-stream lock the append path takes: under READ
                // COMMITTED a concurrent append's version check and this
                // rewrite must not interleave, or the erased version range
                // could be re-populated by the append's inserts.
                yield* lockStream(request.streamName);
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
                // its own version (mirroring the other adapters), so re-reads
                // stay consistent row by row.
                for (let version = 1; version <= request.expectedVersion; version++) {
                  const tombstone = erasedTombstone(request.streamName, version, erasedAt);
                  yield* sql`
                  UPDATE ${sql(tables.events)}
                  SET type = ${tombstone.type},
                      schema_version = ${tombstone.schemaVersion},
                      payload = ${jsonText(tombstone.payload)}::jsonb,
                      metadata = ${jsonText(tombstone.metadata)}::jsonb
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
            .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
          return result satisfies StreamErasureResult;
        }),
    });

    return { service, historyImporter, streamEraser, appendWithOutbox: appendTransaction };
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

/** `EventStore` (with `HistoryImporter` and `StreamEraser`) backed by the `events` table of the `SqlClient` in context. */
export const eventStoreLayer = (
  options?: AdapterOptions,
): Layer.Layer<EventStore | HistoryImporter | StreamEraser, never, SqlClient.SqlClient> =>
  Layer.effectContext(
    Effect.map(make(tableNames(options)), (store) =>
      Context.make(EventStore, store.service).pipe(
        Context.add(HistoryImporter, store.historyImporter),
        Context.add(StreamEraser, store.streamEraser),
      ),
    ),
  );
