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

const locked = () =>
  new Migrator.MigrationError({
    reason: "locked",
    message: "Migrations already running",
  });

const field = (value: unknown, key: PropertyKey): unknown =>
  typeof value === "object" && value !== null
    ? (value as Readonly<Record<PropertyKey, unknown>>)[key]
    : undefined;

const isMissingTable = (error: SqlError): boolean => {
  const cause = error.cause;
  const code = field(cause, "code");
  const errno = field(cause, "errno");
  const number = field(cause, "number");
  const message = field(cause, "message");
  return (
    code === "42P01" ||
    code === "ER_NO_SUCH_TABLE" ||
    code === "UNKNOWN_TABLE" ||
    code === "60" ||
    errno === 1146 ||
    number === 208 ||
    number === 60 ||
    (errno === 1 && typeof message === "string" && message.startsWith("no such table:"))
  );
};

const readAppliedIds = (
  table: string,
): Effect.Effect<ReadonlyArray<number>, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql`SELECT migration_id FROM ${sql(table)}`.pipe(
      Effect.map((rows) => rows.map((row) => Number(row.migration_id))),
      Effect.catchIf(isMissingTable, () => Effect.succeed<ReadonlyArray<number>>([])),
    );
  });

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
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const table = options.table ?? DEFAULT_TABLE;
    const migrate = Migrator.make({})({
      loader: set.loader,
      ...(options.table !== undefined ? { table: options.table } : {}),
    });
    return yield* sql.onDialectOrElse({
      pg: () =>
        sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{ readonly acquired: boolean }>`
              SELECT pg_try_advisory_xact_lock(hashtext(${table})) AS acquired
            `;
            if (rows[0]?.acquired !== true) {
              return yield* locked();
            }
            return yield* migrate;
          }),
        ),
      orElse: () =>
        Effect.gen(function* () {
          const appliedBefore = yield* readAppliedIds(table);
          const latestBefore = appliedBefore.reduce((latest, id) => Math.max(latest, id), 0);
          const hadPending = set.migrations.some((migration) => migration.id > latestBefore);
          const applied = yield* migrate;
          if (hadPending && applied.length === 0) {
            return yield* locked();
          }
          return applied;
        }),
    });
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
    const table = options.table ?? DEFAULT_TABLE;
    const appliedIds = new Set(yield* readAppliedIds(table));
    const applied = set.migrations
      .filter((m) => appliedIds.has(m.id))
      .map((m) => ({ id: m.id, name: m.name }));
    const pending = set.migrations
      .filter((m) => !appliedIds.has(m.id))
      .map((m) => ({ id: m.id, name: m.name }));
    return { applied, pending };
  });
