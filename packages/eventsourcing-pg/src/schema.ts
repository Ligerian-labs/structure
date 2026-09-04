import * as SqlClient from "@effect/sql/SqlClient";
import type { SqlError } from "@effect/sql/SqlError";
import { Effect } from "effect";
import type { IdempotencyStoreOptions } from "./IdempotencyStore.js";

/** Options shared by every adapter in this package. */
export interface AdapterOptions extends IdempotencyStoreOptions {
  /** Prefix prepended to every table name (default: none). */
  readonly tablePrefix?: string;
}

/** Resolved table names for one `tablePrefix`. */
export interface TableNames {
  readonly events: string;
  readonly historyImports: string;
  readonly historyImportBatches: string;
  readonly snapshots: string;
  readonly checkpoints: string;
  readonly outbox: string;
  readonly inbox: string;
  readonly idempotency: string;
}

/** Table names for the given options (default: unprefixed). */
export const tableNames = (options?: AdapterOptions): TableNames => {
  const prefix = options?.tablePrefix ?? "";
  return {
    events: `${prefix}events`,
    historyImports: `${prefix}history_imports`,
    historyImportBatches: `${prefix}history_import_batches`,
    snapshots: `${prefix}snapshots`,
    checkpoints: `${prefix}checkpoints`,
    outbox: `${prefix}outbox`,
    inbox: `${prefix}inbox`,
    idempotency: `${prefix}idempotency`,
  };
};

/**
 * Creates every table this package needs, in order, with idempotent
 * `CREATE TABLE IF NOT EXISTS` statements. Run it once at startup (the
 * package-level `layer` does so automatically).
 *
 * The outbox has an extra `seq BIGSERIAL` column (not part of the port)
 * so `pending` can return entries in stable enqueue order. The idempotency
 * table backs `@structure-ai/cqrs`'s `IdempotencyStore`: one row per
 * `(tag, actor, key)` claim, expiring at `expires_at`.
 */
export const migrate = (
  options?: AdapterOptions,
): Effect.Effect<void, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const tables = tableNames(options);
    yield* sql`
      CREATE TABLE IF NOT EXISTS ${sql(tables.events)} (
        position BIGSERIAL PRIMARY KEY,
        stream_name TEXT NOT NULL,
        version INTEGER NOT NULL,
        type TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        payload JSONB NOT NULL,
        metadata JSONB NOT NULL,
        UNIQUE (stream_name, version)
      )
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS ${sql(tables.historyImports)} (
        import_id TEXT PRIMARY KEY,
        resume_token TEXT NOT NULL,
        last_position BIGINT NOT NULL,
        complete BOOLEAN NOT NULL DEFAULT FALSE
      )
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS ${sql(tables.historyImportBatches)} (
        import_id TEXT NOT NULL,
        batch_id TEXT NOT NULL,
        previous_token TEXT,
        checksum TEXT NOT NULL,
        complete BOOLEAN NOT NULL,
        imported_count INTEGER NOT NULL,
        last_position BIGINT NOT NULL,
        result_token TEXT NOT NULL,
        PRIMARY KEY (import_id, batch_id)
      )
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS ${sql(tables.snapshots)} (
        stream_name TEXT PRIMARY KEY,
        state JSONB NOT NULL,
        version INTEGER NOT NULL
      )
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS ${sql(tables.checkpoints)} (
        name TEXT PRIMARY KEY,
        position BIGINT NOT NULL
      )
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS ${sql(tables.outbox)} (
        id TEXT PRIMARY KEY,
        seq BIGSERIAL,
        topic TEXT NOT NULL,
        payload JSONB NOT NULL,
        metadata JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'dead')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS ${sql(tables.inbox)} (
        consumer_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (consumer_id, message_id)
      )
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS ${sql(tables.idempotency)} (
        tag TEXT NOT NULL,
        actor TEXT NOT NULL,
        key TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('claimed', 'completed')),
        result JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (tag, actor, key)
      )
    `;
    yield* sql`
      CREATE INDEX IF NOT EXISTS ${sql(`${tables.idempotency}_expires_at_idx`)}
      ON ${sql(tables.idempotency)} (expires_at)
    `;
  });
