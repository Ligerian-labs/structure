import * as Migrator from "@effect/sql/Migrator";
import * as SqlClient from "@effect/sql/SqlClient";
import type { SqlError } from "@effect/sql/SqlError";
import { Duration, Effect, Layer, Schedule, type Scope } from "effect";
import type { MigrationSet } from "./migration.js";

/**
 * How `run` excludes concurrent runners.
 *
 * - `"transaction"` (default): a non-blocking `pg_try_advisory_xact_lock`
 *   inside the migration transaction; a second runner fails at once with
 *   `MigrationError("locked")`. Right for a deploy step that owns the retry.
 * - `"session"`: a blocking `pg_advisory_lock` on a dedicated connection,
 *   waited for up to `waitFor`; once acquired the applied set is re-read, so a
 *   waiter that finds nothing left to apply ends green with `[]`. Right for
 *   replicas that boot together and must all end in the same state.
 *
 * Both modes lock the same key, so mixed-mode runners still exclude each
 * other. Outside Postgres there is no advisory lock: `"transaction"` relies on
 * the bookkeeping insert (and, on sqlite, the write lock) to detect the
 * second runner, and `"session"` is emulated by retrying that non-blocking
 * path every 100 ms until `waitFor` elapses.
 */
export type LockMode = "session" | "transaction";

export interface StatusOptions {
  /** Migrations bookkeeping table. Defaults to the library's `effect_sql_migrations`. */
  readonly table?: string;
}

export interface RunOptions extends StatusOptions {
  /** See {@link LockMode}. Defaults to `"transaction"`. */
  readonly lock?: LockMode;
  /**
   * How long a `"session"` runner waits for the lock before failing with
   * `MigrationError("locked")`. Defaults to 30 seconds; an infinite duration
   * waits without bound. Ignored in `"transaction"` mode.
   */
  readonly waitFor?: Duration.DurationInput;
}

const DEFAULT_TABLE = "effect_sql_migrations";
const DEFAULT_WAIT = Duration.seconds(30);
const RETRY_INTERVAL = Duration.millis(100);

const locked = () =>
  new Migrator.MigrationError({
    reason: "locked",
    message: "Migrations already running",
  });

const isLocked = (error: Migrator.MigrationError | SqlError): boolean =>
  error._tag === "MigrationError" && error.reason === "locked";

const field = (value: unknown, key: PropertyKey): unknown =>
  typeof value === "object" && value !== null
    ? (value as Readonly<Record<PropertyKey, unknown>>)[key]
    : undefined;

const messageOf = (error: SqlError): string => {
  const message = field(error.cause, "message");
  return typeof message === "string" ? message : "";
};

const isMissingTable = (error: SqlError): boolean => {
  const cause = error.cause;
  const code = field(cause, "code");
  const errno = field(cause, "errno");
  const number = field(cause, "number");
  return (
    code === "42P01" ||
    code === "ER_NO_SUCH_TABLE" ||
    code === "UNKNOWN_TABLE" ||
    code === "60" ||
    errno === 1146 ||
    number === 208 ||
    number === 60 ||
    (errno === 1 && messageOf(error).startsWith("no such table:"))
  );
};

const isDuplicateColumn = (error: SqlError): boolean => {
  const cause = error.cause;
  const code = field(cause, "code");
  const errno = field(cause, "errno");
  const number = field(cause, "number");
  return (
    code === "42701" ||
    code === "ER_DUP_FIELDNAME" ||
    errno === 1060 ||
    number === 2705 ||
    messageOf(error).includes("duplicate column name")
  );
};

/** sqlite reports a concurrent writer as SQLITE_BUSY ("database is locked"). */
const isBusy = (error: Migrator.MigrationError | SqlError): boolean => {
  if (error._tag !== "SqlError") return false;
  const cause = error.cause;
  return (
    field(cause, "code") === "SQLITE_BUSY" ||
    field(cause, "errno") === 5 ||
    messageOf(error).includes("database is locked")
  );
};

/** The bookkeeping table predates the `checksum` column (installs migrated before it existed). */
const isMissingChecksumColumn = (error: SqlError): boolean => {
  const cause = error.cause;
  const code = field(cause, "code");
  const errno = field(cause, "errno");
  const number = field(cause, "number");
  const message = messageOf(error);
  return (
    (code === "42703" ||
      code === "ER_BAD_FIELD_ERROR" ||
      errno === 1054 ||
      number === 207 ||
      errno === 1) &&
    message.includes("checksum")
  );
};

/** Postgres `lock_timeout` expiry: `lock_not_available`. */
const isLockTimeout = (error: SqlError): boolean => field(error.cause, "code") === "55P03";

interface AppliedRow {
  readonly id: number;
  readonly name: string;
  readonly checksum: string | null;
}

/**
 * Reads the bookkeeping rows as they are. `status` must stay read-only, so a
 * table created before the `checksum` column existed is read without it
 * (its rows carry `null`) instead of being altered; a missing table reads as
 * empty. Any other query error propagates.
 */
const readAppliedRows = (
  table: string,
): Effect.Effect<ReadonlyArray<AppliedRow>, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const toRow = (row: { readonly [column: string]: unknown }): AppliedRow => {
      const checksum = row.checksum;
      return {
        id: Number(row.migration_id),
        name: String(row.name),
        checksum: typeof checksum === "string" ? checksum : null,
      };
    };
    return yield* sql`SELECT migration_id, name, checksum FROM ${sql(table)}`.withoutTransform.pipe(
      Effect.catchIf(
        isMissingChecksumColumn,
        () => sql`SELECT migration_id, name FROM ${sql(table)}`.withoutTransform,
      ),
      Effect.map((rows) => rows.map(toRow)),
      Effect.catchIf(isMissingTable, () => Effect.succeed<ReadonlyArray<AppliedRow>>([])),
    );
  });

export interface MigrationRef {
  readonly id: number;
  readonly name: string;
}

export interface MismatchedMigration extends MigrationRef {
  /** Checksum of the migration as defined in this build. */
  readonly expected: string;
  /** Checksum recorded when the migration ran. */
  readonly actual: string;
}

export interface MigrationStatus {
  /** Migrations of the set recorded as applied (includes the mismatched ones). */
  readonly applied: ReadonlyArray<MigrationRef>;
  /** Migrations of the set not yet recorded. */
  readonly pending: ReadonlyArray<MigrationRef>;
  /**
   * Recorded migrations that are not in the set: the database was migrated
   * by a newer artifact than the running one (e.g. a rollback after a
   * forward migration).
   */
  readonly unknown: ReadonlyArray<MigrationRef>;
  /**
   * Applied migrations whose recorded checksum differs from the set's: the
   * migration was edited or renamed after it ran. Rows recorded before
   * checksums existed (`NULL`) are never reported here; `run` adopts the
   * current checksum for them.
   */
  readonly mismatched: ReadonlyArray<MismatchedMigration>;
}

const reportOf = (set: MigrationSet, rows: ReadonlyArray<AppliedRow>): MigrationStatus => {
  const recorded = new Map(rows.map((row) => [row.id, row] as const));
  const known = new Set(set.migrations.map((m) => m.id));
  const ref = ({ id, name }: MigrationRef): MigrationRef => ({ id, name });
  const mismatched: Array<MismatchedMigration> = [];
  for (const m of set.migrations) {
    const row = recorded.get(m.id);
    if (row !== undefined && row.checksum !== null && row.checksum !== m.checksum) {
      mismatched.push({ id: m.id, name: m.name, expected: m.checksum, actual: row.checksum });
    }
  }
  return {
    applied: set.migrations.filter((m) => recorded.has(m.id)).map(ref),
    pending: set.migrations.filter((m) => !recorded.has(m.id)).map(ref),
    unknown: rows
      .filter((row) => !known.has(row.id))
      .sort((a, b) => a.id - b.id)
      .map(ref),
    mismatched,
  };
};

/**
 * Human-readable list of what makes a status inconsistent with the set
 * (`unknown` and `mismatched` entries); empty when the history matches.
 */
export const inconsistencies = (report: MigrationStatus): ReadonlyArray<string> => [
  ...report.unknown.map(
    (m) => `${m.id} ${m.name}: recorded in the database but not in this migration set`,
  ),
  ...report.mismatched.map(
    (m) =>
      `${m.id} ${m.name}: checksum ${m.actual.slice(0, 12)}… recorded, ${m.expected.slice(0, 12)}… defined`,
  ),
];

const inconsistent = (report: MigrationStatus) =>
  new Migrator.MigrationError({
    reason: "bad-state",
    message: `Database history does not match the migration set:\n${inconsistencies(report)
      .map((line) => `  - ${line}`)
      .join("\n")}`,
  });

const lockTimeoutMillis = (waitFor: Duration.DurationInput | undefined): number | undefined => {
  const duration = Duration.decode(waitFor ?? DEFAULT_WAIT);
  return Duration.isFinite(duration)
    ? Math.max(1, Math.ceil(Duration.toMillis(duration)))
    : undefined;
};

/**
 * Takes the session-level advisory lock for `table` on a dedicated
 * connection, blocking up to `waitFor`, and releases it when the scope
 * closes. `lock_timeout` is set `LOCAL` to a short transaction so it never
 * leaks into the pooled connection; the session lock itself survives the
 * commit by design.
 */
const acquireSessionLock = (
  sql: SqlClient.SqlClient,
  table: string,
  waitFor: Duration.DurationInput | undefined,
): Effect.Effect<void, Migrator.MigrationError | SqlError, Scope.Scope> =>
  Effect.gen(function* () {
    const connection = yield* sql.reserve;
    const exec = (text: string, params: ReadonlyArray<unknown> = []) =>
      connection.execute(text, params, undefined);
    const millis = lockTimeoutMillis(waitFor);
    yield* Effect.logDebug("waiting for migration lock").pipe(
      Effect.annotateLogs({ table, waitForMillis: millis ?? "unbounded" }),
    );
    yield* Effect.gen(function* () {
      yield* exec("BEGIN");
      if (millis !== undefined) {
        yield* exec(`SET LOCAL lock_timeout = ${millis}`);
      }
      yield* exec("SELECT pg_advisory_lock(hashtext($1::text))", [table]);
      yield* exec("COMMIT");
    }).pipe(
      Effect.onError(() => exec("ROLLBACK").pipe(Effect.ignore)),
      Effect.catchIf(isLockTimeout, () => locked()),
    );
    yield* Effect.addFinalizer(() =>
      exec("SELECT pg_advisory_unlock(hashtext($1::text))", [table]).pipe(Effect.ignoreLogged),
    );
  });

/**
 * Applies every pending migration in id order, inside the Migrator's
 * transactional bookkeeping, and records each one's checksum. Returns the
 * `[id, name]` pairs actually applied (empty when up to date).
 *
 * Fail-closed: under the lock the recorded history is re-read and compared
 * with the set; a database ahead of this build (`unknown` rows) or an edited
 * migration (`mismatched` checksum) fails with `MigrationError("bad-state")`
 * before anything is applied. Creates the bookkeeping table and its
 * `checksum` column when missing — safe as the very first run on a fresh
 * database and on a database migrated before checksums existed, whose rows
 * adopt the current checksums.
 *
 * Concurrent runners: see {@link LockMode}.
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
    const lock = options.lock ?? "transaction";
    const migrate = Migrator.make({})({
      loader: set.loader,
      ...(options.table !== undefined ? { table: options.table } : {}),
    });
    // Create the bookkeeping table idempotently before anything else, in the
    // same shape as the upstream Migrator's per dialect. On Postgres the
    // upstream bootstrap probes `select '<table>'::regclass` and falls back
    // to a bare CREATE TABLE when the probe fails; inside a transaction the
    // failed probe aborts it ("current transaction is aborted") on any
    // database that does not have the table yet, so the probe inside the
    // locked transaction below must always succeed. Elsewhere the column
    // check below needs the table to exist before the first migration runs.
    const ensureTable = sql.onDialectOrElse({
      pg: () => sql`CREATE TABLE IF NOT EXISTS ${sql(table)} (
        migration_id integer primary key,
        created_at timestamp with time zone not null default now(),
        name text not null
      )`,
      orElse: () => sql`CREATE TABLE IF NOT EXISTS ${sql(table)} (
        migration_id integer PRIMARY KEY NOT NULL,
        created_at datetime NOT NULL DEFAULT current_timestamp,
        name VARCHAR(255) NOT NULL
      )`,
    });
    // Added after the table's first shape shipped; idempotent for existing
    // installs. Runs under the lock so concurrent runners cannot race it.
    const ensureChecksumColumn = sql.onDialectOrElse({
      pg: () => sql`ALTER TABLE ${sql(table)} ADD COLUMN IF NOT EXISTS checksum text`,
      orElse: () =>
        sql`ALTER TABLE ${sql(table)} ADD COLUMN checksum text`.pipe(
          Effect.catchIf(isDuplicateColumn, () => Effect.void),
        ),
    });
    // The upstream Migrator inserts `(migration_id, name)` only; stamp the
    // rows it just inserted and adopt rows recorded before checksums existed.
    const stampChecksums = Effect.forEach(
      set.migrations,
      (m) =>
        sql`UPDATE ${sql(table)} SET checksum = ${m.checksum} WHERE migration_id = ${m.id} AND checksum IS NULL`
          .withoutTransform,
      { discard: true },
    );
    // Everything a runner does once it owns the lock: verify the history
    // against the set (waiters become verifiers), then apply and stamp.
    const applyLocked = Effect.gen(function* () {
      yield* ensureChecksumColumn;
      const before = reportOf(set, yield* readAppliedRows(table));
      if (inconsistencies(before).length > 0) {
        return yield* inconsistent(before);
      }
      const applied = yield* migrate;
      if (before.pending.length > 0 && applied.length === 0) {
        // Non-pg dialects have no advisory lock: the upstream Migrator maps
        // a failed bookkeeping insert to "locked" and returns [] — with work
        // left undone that means another runner owns it.
        return yield* locked();
      }
      yield* stampChecksums;
      return applied;
    });
    yield* ensureTable;
    return yield* sql.onDialectOrElse({
      pg: () =>
        lock === "session"
          ? Effect.scoped(
              Effect.gen(function* () {
                yield* acquireSessionLock(sql, table, options.waitFor);
                return yield* sql.withTransaction(applyLocked);
              }),
            )
          : sql.withTransaction(
              Effect.gen(function* () {
                const rows = yield* sql<{ readonly acquired: boolean }>`
                  SELECT pg_try_advisory_xact_lock(hashtext(${table})) AS acquired
                `;
                if (rows[0]?.acquired !== true) {
                  return yield* locked();
                }
                return yield* applyLocked;
              }),
            ),
      orElse: () => {
        const attempt = sql
          .withTransaction(applyLocked)
          .pipe(Effect.catchIf(isBusy, () => locked()));
        return lock === "session"
          ? attempt.pipe(
              Effect.retry({
                while: isLocked,
                schedule: Schedule.spaced(RETRY_INTERVAL).pipe(
                  Schedule.upTo(options.waitFor ?? DEFAULT_WAIT),
                ),
              }),
            )
          : attempt;
      },
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

/**
 * Compares the recorded history with the set without touching the database
 * schema: `{ applied, pending, unknown, mismatched }` (see
 * {@link MigrationStatus}). A missing bookkeeping table reads as "nothing
 * applied".
 */
export const status = (
  set: MigrationSet,
  options: StatusOptions = {},
): Effect.Effect<MigrationStatus, SqlError, SqlClient.SqlClient> =>
  Effect.map(readAppliedRows(options.table ?? DEFAULT_TABLE), (rows) => reportOf(set, rows));
