import * as SqlClient from "@effect/sql/SqlClient";
import type { SqlError } from "@effect/sql/SqlError";
import { Effect } from "effect";

/** Options shared by every adapter in this package. */
export interface AdapterOptions {
  /** Prefix prepended to every table name (default: none). */
  readonly tablePrefix?: string;
}

/** Resolved table names for one `tablePrefix`. */
export interface TableNames {
  readonly events: string;
  readonly snapshots: string;
  readonly checkpoints: string;
  readonly outbox: string;
  readonly inbox: string;
}

/** Table names for the given options (default: unprefixed). */
export const tableNames = (options?: AdapterOptions): TableNames => {
  const prefix = options?.tablePrefix ?? "";
  return {
    events: `${prefix}events`,
    snapshots: `${prefix}snapshots`,
    checkpoints: `${prefix}checkpoints`,
    outbox: `${prefix}outbox`,
    inbox: `${prefix}inbox`,
  };
};

/**
 * Creates every table this package needs, in order, with idempotent
 * `CREATE TABLE IF NOT EXISTS` statements, plus the expression index on
 * the envelope's partition (`json_extract(metadata, '$.partition')`) that
 * serves `readAll({ partition })`. Run it once at startup (the
 * package-level `layer` does so automatically); on a database created by
 * an earlier version the index is simply added.
 */
export const migrate = (
  options?: AdapterOptions,
): Effect.Effect<void, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const tables = tableNames(options);
    yield* sql`
      CREATE TABLE IF NOT EXISTS ${sql(tables.events)} (
        position INTEGER PRIMARY KEY AUTOINCREMENT,
        stream_name TEXT NOT NULL,
        version INTEGER NOT NULL,
        type TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        payload TEXT NOT NULL,
        metadata TEXT NOT NULL,
        UNIQUE (stream_name, version)
      )
    `;
    yield* sql`
      CREATE INDEX IF NOT EXISTS ${sql(`${tables.events}_partition_position_idx`)}
      ON ${sql(tables.events)} (json_extract(metadata, '$.partition'), position)
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS ${sql(tables.snapshots)} (
        stream_name TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        version INTEGER NOT NULL
      )
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS ${sql(tables.checkpoints)} (
        name TEXT PRIMARY KEY,
        position INTEGER NOT NULL
      )
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS ${sql(tables.outbox)} (
        id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        payload TEXT NOT NULL,
        metadata TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'dead')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS ${sql(tables.inbox)} (
        consumer_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (consumer_id, message_id)
      )
    `;
  });
