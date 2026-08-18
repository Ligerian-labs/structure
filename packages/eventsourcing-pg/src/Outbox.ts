import * as SqlClient from "@effect/sql/SqlClient";
import { Inbox, Outbox, type OutboxEntry, type OutboxStatus } from "@structure/eventsourcing";
import { Effect, Layer } from "effect";
import { jsonText, toNumber } from "./internal.js";
import { type AdapterOptions, tableNames } from "./schema.js";

interface OutboxRow {
  readonly id: string;
  readonly topic: string;
  readonly payload: string;
  readonly metadata: string;
  readonly status: string;
  readonly attempts: number | bigint | string;
  readonly last_error: string | null;
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
  return row.last_error === null ? entry : { ...entry, lastError: row.last_error };
};

/**
 * `Outbox` persisting staged messages in `outbox`. `enqueue` is idempotent
 * per message id (`ON CONFLICT DO NOTHING`); enqueue order is the table's
 * `seq` (BIGSERIAL) order.
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
          SELECT id, topic, payload::text AS payload, metadata::text AS metadata,
                 status, attempts, last_error
          FROM ${sql(tables.outbox)}
          WHERE status = ${whereStatus}
          ORDER BY seq ASC
        `;
        const query =
          limit === undefined ? sql<OutboxRow>`${base}` : sql<OutboxRow>`${base} LIMIT ${limit}`;
        return query.pipe(
          Effect.orDie,
          Effect.map((rows) => rows.map(decodeEntry)),
        );
      };
      return Outbox.of({
        enqueue: (messages) =>
          Effect.forEach(
            messages,
            (message) => sql`
              INSERT INTO ${sql(tables.outbox)} (id, topic, payload, metadata, status, attempts)
              VALUES (${message.id}, ${message.topic}, ${jsonText(message.payload)}::jsonb,
                      ${jsonText(message.metadata)}::jsonb, 'pending', 0)
              ON CONFLICT (id) DO NOTHING
            `,
            { discard: true },
          ).pipe(Effect.orDie),
        pending: (limit) => entries("pending", limit),
        markPublished: (ids) =>
          ids.length === 0
            ? Effect.void
            : sql`
                UPDATE ${sql(tables.outbox)}
                SET status = 'published', updated_at = now()
                WHERE id IN ${sql.in(ids)}
              `.pipe(Effect.orDie, Effect.asVoid),
        markFailed: (id, error, attempts) =>
          sql`
            UPDATE ${sql(tables.outbox)}
            SET attempts = ${attempts}, last_error = ${error}, updated_at = now()
            WHERE id = ${id}
          `.pipe(Effect.orDie, Effect.asVoid),
        markDead: (id, error) =>
          sql`
            UPDATE ${sql(tables.outbox)}
            SET status = 'dead', last_error = ${error}, updated_at = now()
            WHERE id = ${id}
          `.pipe(Effect.orDie, Effect.asVoid),
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
          sql<{ readonly one: number | bigint | string }>`
            SELECT 1 AS one
            FROM ${sql(tables.inbox)}
            WHERE consumer_id = ${consumerId} AND message_id = ${messageId}
          `.pipe(
            Effect.orDie,
            Effect.map((rows) => rows.length > 0),
          ),
        markProcessed: (consumerId, messageId) =>
          sql`
            INSERT INTO ${sql(tables.inbox)} (consumer_id, message_id)
            VALUES (${consumerId}, ${messageId})
            ON CONFLICT (consumer_id, message_id) DO NOTHING
          `.pipe(Effect.orDie, Effect.asVoid),
      });
    }),
  );
