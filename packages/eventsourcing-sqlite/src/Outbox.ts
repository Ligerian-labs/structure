import { randomUUID } from "node:crypto";
import * as SqlClient from "@effect/sql/SqlClient";
import { PersistenceError } from "@structure-ai/domain";
import {
  Inbox,
  Outbox,
  type OutboxClaim,
  type OutboxEntry,
  type OutboxMessage,
  type OutboxStatus,
} from "@structure-ai/eventsourcing";
import { Clock, Duration, Effect, Layer } from "effect";
import { jsonText, toNumber } from "./internal.js";
import { type AdapterOptions, tableNames } from "./schema.js";

interface OutboxRow {
  readonly id: string;
  readonly topic: string;
  readonly payload: string;
  readonly metadata: string;
  readonly status: string;
  readonly attempts: number | bigint;
  readonly last_error: string | null;
  readonly available_at: number | bigint | string | null;
}

/** The entries columns, plus the claim/lease bookkeeping columns. */
interface ClaimRow extends OutboxRow {
  readonly claim_token: string | null;
  readonly lease_until: number | bigint | string | null;
}

const decodeEntry = (row: OutboxRow): OutboxEntry => {
  const entry: OutboxEntry = {
    message: {
      id: row.id,
      topic: row.topic,
      payload: JSON.parse(row.payload) as unknown,
      metadata: JSON.parse(row.metadata) as Readonly<Record<string, unknown>>,
    },
    status: row.status as OutboxStatus,
    attempts: toNumber(row.attempts),
  };
  const withError = row.last_error === null ? entry : { ...entry, lastError: row.last_error };
  return row.available_at === null
    ? withError
    : { ...withError, availableAt: Number(row.available_at) };
};

/** The stored columns of one message, schedule included. */
const messageColumns = (
  message: OutboxMessage,
): {
  readonly id: string;
  readonly topic: string;
  readonly payload: string;
  readonly metadata: string;
  readonly availableAt: number | null;
} => ({
  id: message.id,
  topic: message.topic,
  payload: jsonText(message.payload),
  metadata: jsonText(message.metadata),
  availableAt: message.availableAt ?? null,
});

/**
 * `Outbox` persisting staged messages in `outbox`. `enqueue` is idempotent
 * per message id (`ON CONFLICT DO NOTHING`); enqueue order is the table's
 * insertion (rowid) order. `pending` returns only entries whose
 * `available_at` (epoch milliseconds, set by `enqueue` for scheduled
 * messages or by `markFailed` for the retry backoff) has elapsed, and
 * whose claim lease (taken by `claim`) has not lapsed. `claim` writes a
 * claim token plus lease deadline in one UPDATE, giving each relay
 * exclusive delivery ownership of its batch; settlements are fenced by
 * the token (broker visibility-timeout semantics).
 */
export const outboxLayer = (
  options?: AdapterOptions,
): Layer.Layer<Outbox, never, SqlClient.SqlClient> =>
  Layer.effect(
    Outbox,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const tables = tableNames(options);
      const entries = (whereStatus: OutboxStatus, limit?: number) => {
        const base = sql`
          SELECT id, topic, payload, metadata, status, attempts, last_error, available_at
          FROM ${sql(tables.outbox)}
          WHERE status = ${whereStatus}
          ORDER BY rowid ASC
        `;
        const query =
          limit === undefined ? sql<OutboxRow>`${base}` : sql<OutboxRow>`${base} LIMIT ${limit}`;
        return query.pipe(
          Effect.mapError((cause) => new PersistenceError({ operation: "Outbox", cause })),
          Effect.flatMap((rows) =>
            Effect.try({
              try: () => rows.map(decodeEntry),
              catch: (cause) => new PersistenceError({ operation: "outbox.decode", cause }),
            }),
          ),
        );
      };
      return Outbox.of({
        enqueue: (messages) =>
          Effect.forEach(
            messages,
            (message) =>
              Effect.gen(function* () {
                const columns = yield* Effect.try({
                  try: () => messageColumns(message),
                  catch: (cause) => new PersistenceError({ operation: "outbox.encode", cause }),
                });
                return yield* sql`
                INSERT INTO ${sql(tables.outbox)} (id, topic, payload, metadata, status, attempts, available_at)
                VALUES (${columns.id}, ${columns.topic}, ${columns.payload},
                        ${columns.metadata}, 'pending', 0, ${columns.availableAt})
                ON CONFLICT (id) DO NOTHING
              `;
              }),
            { discard: true },
          ).pipe(
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(new PersistenceError({ operation: "Outbox", cause })),
            ),
          ),
        pending: (limit) =>
          Effect.flatMap(Clock.currentTimeMillis, (now) =>
            sql<OutboxRow>`
              SELECT id, topic, payload, metadata, status, attempts, last_error, available_at
              FROM ${sql(tables.outbox)}
              WHERE status = 'pending' AND (available_at IS NULL OR available_at <= ${now})
                AND (claim_token IS NULL OR lease_until IS NULL OR lease_until <= ${now})
              ORDER BY rowid ASC
              LIMIT ${limit}
            `.pipe(
              Effect.mapError((cause) => new PersistenceError({ operation: "Outbox", cause })),
              Effect.flatMap((rows) =>
                Effect.try({
                  try: () => rows.map(decodeEntry),
                  catch: (cause) => new PersistenceError({ operation: "outbox.decode", cause }),
                }),
              ),
            ),
          ),
        claim: (limit, lease) =>
          Effect.flatMap(Clock.currentTimeMillis, (now) => {
            const leaseUntil = now + Duration.toMillis(lease);
            const token = randomUUID();
            return Effect.gen(function* () {
              const claimed = yield* sql<{ readonly id: string }>`
                UPDATE ${sql(tables.outbox)}
                SET claim_token = ${token}, lease_until = ${leaseUntil}, updated_at = CURRENT_TIMESTAMP
                WHERE rowid IN (
                  SELECT rowid FROM ${sql(tables.outbox)}
                  WHERE status = 'pending' AND (available_at IS NULL OR available_at <= ${now})
                    AND (claim_token IS NULL OR lease_until IS NULL OR lease_until <= ${now})
                  ORDER BY rowid ASC
                  LIMIT ${limit}
                )
                RETURNING id
              `;
              if (claimed.length === 0) {
                return { entries: [], token, leaseUntil } satisfies OutboxClaim;
              }
              const rows = yield* sql<ClaimRow>`
                SELECT id, topic, payload, metadata, status, attempts, last_error, available_at,
                       claim_token, lease_until
                FROM ${sql(tables.outbox)}
                WHERE claim_token = ${token}
                ORDER BY rowid ASC
              `;
              return {
                entries: yield* Effect.try({
                  try: () => rows.map(decodeEntry),
                  catch: (cause) => new PersistenceError({ operation: "outbox.decode", cause }),
                }),
                token,
                leaseUntil,
              } satisfies OutboxClaim;
            });
          }).pipe(Effect.mapError((cause) => new PersistenceError({ operation: "Outbox", cause }))),
        markPublished: (ids, claim) =>
          ids.length === 0
            ? Effect.succeed(false)
            : Effect.flatMap(
                sql<{ readonly id: string }>`
                  UPDATE ${sql(tables.outbox)}
                  SET status = 'published', claim_token = NULL, lease_until = NULL,
                      updated_at = CURRENT_TIMESTAMP
                  WHERE id IN ${sql.in(ids)} AND status = 'pending'
                    ${claim === undefined ? sql`` : sql`AND claim_token = ${claim}`}
                  RETURNING id
                `,
                (rows) => Effect.succeed(rows.length > 0),
              ).pipe(
                Effect.mapError((cause) => new PersistenceError({ operation: "Outbox", cause })),
              ),
        markFailed: (id, error, attempts, retryAt, claim) =>
          Effect.flatMap(
            sql<{ readonly id: string }>`
              UPDATE ${sql(tables.outbox)}
              SET attempts = ${attempts}, last_error = ${error}, available_at = ${retryAt ?? null},
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = ${id} AND status = 'pending'
                ${claim === undefined ? sql`` : sql`AND claim_token = ${claim}`}
              RETURNING id
            `,
            (rows) => Effect.succeed(rows.length > 0),
          ).pipe(Effect.mapError((cause) => new PersistenceError({ operation: "Outbox", cause }))),
        markDead: (id, error, claim) =>
          Effect.flatMap(
            sql<{ readonly id: string }>`
              UPDATE ${sql(tables.outbox)}
              SET status = 'dead', last_error = ${error}, claim_token = NULL, lease_until = NULL,
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = ${id} AND status = 'pending'
                ${claim === undefined ? sql`` : sql`AND claim_token = ${claim}`}
              RETURNING id
            `,
            (rows) => Effect.succeed(rows.length > 0),
          ).pipe(Effect.mapError((cause) => new PersistenceError({ operation: "Outbox", cause }))),
        replay: (ids) =>
          ids.length === 0
            ? Effect.void
            : sql`
                UPDATE ${sql(tables.outbox)}
                SET status = 'pending', attempts = 0, last_error = NULL, available_at = NULL,
                    claim_token = NULL, lease_until = NULL, updated_at = CURRENT_TIMESTAMP
                WHERE id IN ${sql.in(ids)} AND status = 'dead'
              `.pipe(
                Effect.mapError((cause) => new PersistenceError({ operation: "Outbox", cause })),
                Effect.asVoid,
              ),
        deadLetters: () => entries("dead"),
      });
    }),
  );

/** `Inbox` remembering processed (consumer, message) pairs in `inbox`. */
export const inboxLayer = (
  options?: AdapterOptions,
): Layer.Layer<Inbox, never, SqlClient.SqlClient> =>
  Layer.effect(
    Inbox,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const tables = tableNames(options);
      return Inbox.of({
        seen: (consumerId, messageId) =>
          sql<{ readonly one: number | bigint }>`
            SELECT 1 AS one
            FROM ${sql(tables.inbox)}
            WHERE consumer_id = ${consumerId} AND message_id = ${messageId}
          `.pipe(
            Effect.mapError((cause) => new PersistenceError({ operation: "Outbox", cause })),
            Effect.map((rows) => rows.length > 0),
          ),
        markProcessed: (consumerId, messageId) =>
          sql`
            INSERT INTO ${sql(tables.inbox)} (consumer_id, message_id)
            VALUES (${consumerId}, ${messageId})
            ON CONFLICT (consumer_id, message_id) DO NOTHING
          `.pipe(
            Effect.mapError((cause) => new PersistenceError({ operation: "Outbox", cause })),
            Effect.asVoid,
          ),
      });
    }),
  );
