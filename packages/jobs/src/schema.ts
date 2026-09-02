import * as SqlClient from "@effect/sql/SqlClient";
import { Effect } from "effect";

export interface AdapterOptions {
  /** Table name prefix. Defaults to `jobs_`. */
  readonly tablePrefix?: string;
}

export interface TableNames {
  readonly queue: string;
  readonly deadLetters: string;
}

export const tableNames = (options: AdapterOptions = {}): TableNames => {
  const prefix = options.tablePrefix ?? "jobs_";
  return {
    queue: `${prefix}queue`,
    deadLetters: `${prefix}dead_letters`,
  };
};

/**
 * Creates the jobs schema in one transaction, `@structure-ai/migrations`
 * style (idempotent DDL a designated migrator can run at boot). The queue
 * index covers the dispatch predicate (`status = queued AND run_at <= now`
 * plus lease-expiry reclaims).
 */
export const migrate = (
  options: AdapterOptions = {},
): Effect.Effect<void, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const tables = tableNames(options);
    yield* sql`
      CREATE TABLE IF NOT EXISTS ${sql(tables.queue)} (
        id TEXT PRIMARY KEY,
        job_name TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running')),
        run_at TIMESTAMPTZ NOT NULL,
        cron_expr TEXT,
        cron_timezone TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        lease_expires_at TIMESTAMPTZ,
        last_error TEXT,
        correlation_id TEXT,
        causation_id TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `;
    yield* sql`
      CREATE INDEX IF NOT EXISTS ${sql(`${tables.queue}_dispatch_idx`)}
      ON ${sql(tables.queue)} (status, run_at)
    `;
    yield* sql`
      CREATE INDEX IF NOT EXISTS ${sql(`${tables.queue}_lease_idx`)}
      ON ${sql(tables.queue)} (status, lease_expires_at)
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS ${sql(tables.deadLetters)} (
        id TEXT PRIMARY KEY,
        job_name TEXT NOT NULL,
        payload TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        last_error TEXT,
        correlation_id TEXT,
        dead_at TIMESTAMPTZ NOT NULL
      )
    `;
  }).pipe(Effect.orDie);
