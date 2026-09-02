import * as SqlClient from "@effect/sql/SqlClient";
import type { SqlError } from "@effect/sql/SqlError";
import { Effect } from "effect";

/** Options shared by every adapter in this package. */
export interface SidecarOptions {
  /** Prefix prepended to every sidecar table name (default: none). */
  readonly tablePrefix?: string;
}

/** Resolved sidecar table names for one `tablePrefix`. */
export interface SidecarTables {
  /** Optimistic-concurrency ledger: stream → last reserved version. */
  readonly streams: string;
  /** Events reserved in the ledger but not yet confirmed in the topic. */
  readonly pending: string;
  readonly snapshots: string;
  readonly checkpoints: string;
  readonly inbox: string;
}

/** Table names for the given options (default: unprefixed). */
export const sidecarTables = (options?: SidecarOptions): SidecarTables => {
  const prefix = options?.tablePrefix ?? "";
  return {
    streams: `${prefix}nisshi_streams`,
    pending: `${prefix}nisshi_pending`,
    snapshots: `${prefix}nisshi_snapshots`,
    checkpoints: `${prefix}nisshi_checkpoints`,
    inbox: `${prefix}nisshi_inbox`,
  };
};

/**
 * Creates every sidecar table, idempotently. Dialect is deliberately kept to
 * the common SQL subset so the same statements run on bun:sqlite and
 * PostgreSQL `SqlClient`s. Positions are BIGINT (they are Kafka offsets + 1).
 */
export const migrate = (
  options?: SidecarOptions,
): Effect.Effect<void, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const tables = sidecarTables(options);
    yield* sql`
      CREATE TABLE IF NOT EXISTS ${sql(tables.streams)} (
        stream_name TEXT PRIMARY KEY,
        last_version BIGINT NOT NULL
      )
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS ${sql(tables.pending)} (
        stream_name TEXT NOT NULL,
        version BIGINT NOT NULL,
        topic TEXT NOT NULL,
        record_value TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (stream_name, version)
      )
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS ${sql(tables.snapshots)} (
        stream_name TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        version BIGINT NOT NULL
      )
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS ${sql(tables.checkpoints)} (
        name TEXT PRIMARY KEY,
        position BIGINT NOT NULL
      )
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS ${sql(tables.inbox)} (
        consumer_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        PRIMARY KEY (consumer_id, message_id)
      )
    `;
  });
