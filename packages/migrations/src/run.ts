import * as Migrator from "@effect/sql/Migrator";
import * as SqlClient from "@effect/sql/SqlClient";
import type { SqlError } from "@effect/sql/SqlError";
import { Effect, Layer } from "effect";
import type { MigrationSet } from "./migration.js";

export interface RunOptions {
  /** Migrations bookkeeping table. Defaults to the library's `effect_sql_migrations`. */
  readonly table?: string;
}

const DEFAULT_TABLE = "effect_sql_migrations";

/**
 * Applies every pending migration in id order, inside the Migrator's
 * transactional bookkeeping. Returns the `[id, name]` pairs actually applied
 * (empty when up to date). Concurrent runners are safe: the library locks
 * the migrations table, and a second runner fails with a `MigrationError`
 * (`reason: "locked"`) rather than double-applying.
 */
export const run = (
  set: MigrationSet,
  options: RunOptions = {},
): Effect.Effect<
  ReadonlyArray<readonly [id: number, name: string]>,
  Migrator.MigrationError | SqlError,
  SqlClient.SqlClient
> =>
  Migrator.make({})({
    loader: set.loader,
    ...(options.table !== undefined ? { table: options.table } : {}),
  }).pipe(
    Effect.tap((applied) =>
      applied.length === 0
        ? Effect.logDebug("migrations up to date")
        : Effect.log("migrations applied").pipe(
            Effect.annotateLogs({
              count: applied.length,
              latest: applied[applied.length - 1]?.[1],
            }),
          ),
    ),
    Effect.withSpan("migrations.run"),
  );

/**
 * Runs migrations as part of layer construction. Include it explicitly in
 * the process that is allowed to migrate (a deploy job, a CLI command, or a
 * single writer's startup) — never implicitly in every instance.
 */
export const layer = (set: MigrationSet, options: RunOptions = {}) =>
  Layer.effectDiscard(run(set, options));

export interface MigrationStatus {
  readonly applied: ReadonlyArray<{ readonly id: number; readonly name: string }>;
  readonly pending: ReadonlyArray<{ readonly id: number; readonly name: string }>;
}

/**
 * Reports which migrations of the set have run and which are pending.
 * A missing bookkeeping table reads as "nothing applied".
 */
export const status = (
  set: MigrationSet,
  options: RunOptions = {},
): Effect.Effect<MigrationStatus, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const table = options.table ?? DEFAULT_TABLE;
    const rows = yield* sql`SELECT migration_id FROM ${sql(table)}`.pipe(
      Effect.map((r) => r.map((row) => Number(row.migration_id))),
      Effect.catchAll(() => Effect.succeed<ReadonlyArray<number>>([])),
    );
    const appliedIds = new Set(rows);
    const applied = set.migrations
      .filter((m) => appliedIds.has(m.id))
      .map((m) => ({ id: m.id, name: m.name }));
    const pending = set.migrations
      .filter((m) => !appliedIds.has(m.id))
      .map((m) => ({ id: m.id, name: m.name }));
    return { applied, pending };
  });
