import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as SqlClient from "@effect/sql/SqlClient";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Cause, Deferred, Effect, Exit, Option } from "effect";
import {
  defineMigration,
  InvalidMigrationSet,
  makeSet,
  migrationChecksum,
  migrationsReadinessCheck,
  run,
  status,
} from "../src/index.js";

const sqlite = () => SqliteClient.layer({ filename: ":memory:" });
const sqliteFile = (filename: string) => SqliteClient.layer({ filename });

const createUsersSql = "CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT)";
const createUsers = defineMigration(
  1,
  "create_users",
  Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(createUsersSql)).pipe(Effect.asVoid),
  { sql: createUsersSql },
);
const addEmail = defineMigration(
  2,
  "add_email",
  Effect.flatMap(SqlClient.SqlClient, (sql) => sql`ALTER TABLE users ADD COLUMN email TEXT`),
);
const seed = defineMigration(
  3,
  "seed_admin",
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`INSERT INTO users (id, name, email) VALUES ('u1', 'admin', 'a@example.com')`,
  ),
);

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E | undefined => {
  if (!Exit.isFailure(exit)) return undefined;
  const failure = Cause.failureOption(exit.cause);
  return Option.isSome(failure) ? failure.value : undefined;
};

/** Two runners against one sqlite file: the first blocks inside migration 1 until released. */
const blockingFixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "structure-migrations-"));
  const filename = join(directory, "test.sqlite");
  const entered = await Effect.runPromise(Deferred.make<void>());
  const release = await Effect.runPromise(Deferred.make<void>());
  const blocking = defineMigration(
    1,
    "blocking",
    Effect.gen(function* () {
      yield* Deferred.succeed(entered, undefined);
      yield* Deferred.await(release);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE blocked_until_released (id INTEGER PRIMARY KEY)`;
    }),
  );
  const set = makeSet([blocking]);
  const first = Effect.runPromise(
    run(set).pipe(Effect.provide(sqliteFile(filename)), Effect.scoped),
  );
  await Effect.runPromise(Deferred.await(entered));
  return {
    set,
    filename,
    first,
    release: () => Effect.runPromise(Deferred.succeed(release, undefined)),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
};

describe("migrations", () => {
  test("applies pending migrations in id order and records them", async () => {
    const set = makeSet([seed, createUsers, addEmail]); // deliberately unordered input
    const program = Effect.gen(function* () {
      const applied = yield* run(set);
      expect(applied.map(([id]) => id)).toEqual([1, 2, 3]);
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql`SELECT email FROM users`;
      expect(rows).toHaveLength(1);
      const report = yield* status(set);
      expect(report.pending).toHaveLength(0);
      expect(report.unknown).toHaveLength(0);
      expect(report.mismatched).toHaveLength(0);
      expect(report.applied.map((m) => m.name)).toEqual([
        "create_users",
        "add_email",
        "seed_admin",
      ]);
    });
    await Effect.runPromise(program.pipe(Effect.provide(sqlite()), Effect.scoped));
  });

  test("records a sha-256 checksum per applied migration", async () => {
    const set = makeSet([createUsers, addEmail]);
    const program = Effect.gen(function* () {
      yield* run(set);
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly migration_id: number; readonly checksum: string }>`
        SELECT migration_id, checksum FROM effect_sql_migrations ORDER BY migration_id
      `;
      expect(rows.map((r) => r.checksum)).toEqual([createUsers.checksum, addEmail.checksum]);
      for (const row of rows) {
        expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
      }
    });
    await Effect.runPromise(program.pipe(Effect.provide(sqlite()), Effect.scoped));
  });

  test("checksums cover id, name and declared sql", () => {
    expect(migrationChecksum(1, "a", "x")).toBe(migrationChecksum(1, "a", "x"));
    expect(migrationChecksum(1, "a", "x")).toBe(migrationChecksum(1, "a", ["x"]));
    expect(migrationChecksum(1, "a", "x")).not.toBe(migrationChecksum(1, "a", "y"));
    expect(migrationChecksum(1, "a", "x")).not.toBe(migrationChecksum(1, "b", "x"));
    expect(migrationChecksum(1, "a", "x")).not.toBe(migrationChecksum(2, "a", "x"));
    expect(migrationChecksum(1, "a")).not.toBe(migrationChecksum(1, "a", ""));
    expect(defineMigration(1, "a", Effect.void).checksum).toBe(migrationChecksum(1, "a"));
  });

  test("re-running is a no-op; new migrations apply incrementally", async () => {
    const first = makeSet([createUsers, addEmail]);
    const full = makeSet([createUsers, addEmail, seed]);
    const program = Effect.gen(function* () {
      const initial = yield* run(first);
      expect(initial).toHaveLength(2);
      const again = yield* run(first);
      expect(again).toHaveLength(0);
      const before = yield* status(full);
      expect(before.pending.map((m) => m.id)).toEqual([3]);
      const incremental = yield* run(full);
      expect(incremental.map(([id]) => id)).toEqual([3]);
    });
    await Effect.runPromise(program.pipe(Effect.provide(sqlite()), Effect.scoped));
  });

  test("a failing migration rolls back the whole run (all-or-nothing)", async () => {
    const bad = defineMigration(
      2,
      "broken",
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql`THIS IS NOT SQL`),
    );
    const set = makeSet([createUsers, bad]);
    const program = Effect.gen(function* () {
      const exit = yield* Effect.exit(run(set));
      expect(Exit.isFailure(exit)).toBe(true);
      // The Migrator runs each invocation in one transaction: migration 1 is
      // rolled back along with the failing migration 2.
      const report = yield* status(set);
      expect(report.applied).toHaveLength(0);
      expect(report.pending.map((m) => m.id)).toEqual([1, 2]);
    });
    await Effect.runPromise(program.pipe(Effect.provide(sqlite()), Effect.scoped));
  });

  test("status reads as all-pending before any run", async () => {
    const set = makeSet([createUsers]);
    const program = Effect.gen(function* () {
      const report = yield* status(set);
      expect(report.applied).toHaveLength(0);
      expect(report.pending.map((m) => m.id)).toEqual([1]);
      expect(report.unknown).toHaveLength(0);
      expect(report.mismatched).toHaveLength(0);
    });
    await Effect.runPromise(program.pipe(Effect.provide(sqlite()), Effect.scoped));
  });

  test("status propagates bookkeeping query errors other than a missing table", async () => {
    const set = makeSet([createUsers]);
    const program = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE effect_sql_migrations (wrong_column INTEGER)`;
      yield* sql`INSERT INTO effect_sql_migrations (wrong_column) VALUES (1)`;

      const exit = yield* Effect.exit(status(set));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failureOf(exit)).toMatchObject({ _tag: "SqlError" });
    });
    await Effect.runPromise(program.pipe(Effect.provide(sqlite()), Effect.scoped));
  });

  test("a database ahead of the set reports unknown rows and run refuses", async () => {
    const full = makeSet([createUsers, addEmail, seed]);
    const older = makeSet([createUsers, addEmail]);
    const program = Effect.gen(function* () {
      yield* run(full);
      const report = yield* status(older);
      expect(report.applied.map((m) => m.id)).toEqual([1, 2]);
      expect(report.pending).toHaveLength(0);
      expect(report.unknown).toEqual([{ id: 3, name: "seed_admin" }]);
      expect(report.mismatched).toHaveLength(0);

      const exit = yield* Effect.exit(run(older));
      expect(failureOf(exit)).toMatchObject({ _tag: "MigrationError", reason: "bad-state" });

      const check = yield* migrationsReadinessCheck(older);
      expect(check.name).toBe("migrations");
      expect(yield* check.run).toBe(false);
      const healthy = yield* migrationsReadinessCheck(full);
      expect(yield* healthy.run).toBe(true);
    });
    await Effect.runPromise(program.pipe(Effect.provide(sqlite()), Effect.scoped));
  });

  test("checksum drift is reported and nothing is applied", async () => {
    const edited = defineMigration(1, "create_users", createUsers.up, {
      sql: `${createUsersSql} -- edited after it ran`,
    });
    const original = makeSet([createUsers]);
    const drifted = makeSet([edited, addEmail]);
    const program = Effect.gen(function* () {
      yield* run(original);
      const report = yield* status(drifted);
      expect(report.applied.map((m) => m.id)).toEqual([1]);
      expect(report.pending.map((m) => m.id)).toEqual([2]);
      expect(report.mismatched).toEqual([
        {
          id: 1,
          name: "create_users",
          expected: edited.checksum,
          actual: createUsers.checksum,
        },
      ]);

      const exit = yield* Effect.exit(run(drifted));
      expect(failureOf(exit)).toMatchObject({ _tag: "MigrationError", reason: "bad-state" });
      const after = yield* status(drifted);
      expect(after.pending.map((m) => m.id)).toEqual([2]);
      const sql = yield* SqlClient.SqlClient;
      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(users)`;
      expect(columns.map((c) => c.name)).not.toContain("email");

      const check = yield* migrationsReadinessCheck(drifted);
      expect(yield* check.run).toBe(false);
    });
    await Effect.runPromise(program.pipe(Effect.provide(sqlite()), Effect.scoped));
  });

  test("readiness check is not ready while migrations are pending", async () => {
    const set = makeSet([createUsers]);
    const program = Effect.gen(function* () {
      const check = yield* migrationsReadinessCheck(set, { name: "schema" });
      expect(check.name).toBe("schema");
      expect(yield* check.run).toBe(false);
      yield* run(set);
      expect(yield* check.run).toBe(true);
    });
    await Effect.runPromise(program.pipe(Effect.provide(sqlite()), Effect.scoped));
  });

  test("adopts a legacy bookkeeping table that has no checksum column", async () => {
    const set = makeSet([createUsers, addEmail]);
    const program = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE effect_sql_migrations (
        migration_id integer PRIMARY KEY NOT NULL,
        created_at datetime NOT NULL DEFAULT current_timestamp,
        name VARCHAR(255) NOT NULL
      )`;
      yield* sql.unsafe(createUsersSql);
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (1, 'create_users')`;

      const before = yield* status(set);
      expect(before.applied.map((m) => m.id)).toEqual([1]);
      expect(before.pending.map((m) => m.id)).toEqual([2]);
      expect(before.mismatched).toHaveLength(0);

      const applied = yield* run(set);
      expect(applied.map(([id]) => id)).toEqual([2]);
      const rows = yield* sql<{ readonly migration_id: number; readonly checksum: string }>`
        SELECT migration_id, checksum FROM effect_sql_migrations ORDER BY migration_id
      `;
      expect(rows.map((r) => r.checksum)).toEqual([createUsers.checksum, addEmail.checksum]);
    });
    await Effect.runPromise(program.pipe(Effect.provide(sqlite()), Effect.scoped));
  });

  test("a concurrent transaction-mode runner surfaces lock contention", async () => {
    const fixture = await blockingFixture();
    try {
      const second = await Effect.runPromise(
        Effect.exit(run(fixture.set)).pipe(
          Effect.provide(sqliteFile(fixture.filename)),
          Effect.scoped,
        ),
      );
      expect(failureOf(second)).toMatchObject({ _tag: "MigrationError", reason: "locked" });
    } finally {
      await fixture.release();
      try {
        await fixture.first;
      } finally {
        await fixture.cleanup();
      }
    }
  });

  test("session mode on sqlite waits for the holder, then ends with nothing to do", async () => {
    const fixture = await blockingFixture();
    try {
      const second = Effect.runPromise(
        run(fixture.set, { lock: "session", waitFor: "10 seconds" }).pipe(
          Effect.provide(sqliteFile(fixture.filename)),
          Effect.scoped,
        ),
      );
      const settledEarly = await Promise.race([
        second.then(
          () => true,
          () => true,
        ),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 300)),
      ]);
      expect(settledEarly).toBe(false);
      await fixture.release();
      expect(await fixture.first).toHaveLength(1);
      expect(await second).toHaveLength(0);
    } finally {
      await fixture.release();
      try {
        await fixture.first;
      } finally {
        await fixture.cleanup();
      }
    }
  });

  test("session mode on sqlite gives up with locked once waitFor elapses", async () => {
    const fixture = await blockingFixture();
    try {
      const second = await Effect.runPromise(
        Effect.exit(run(fixture.set, { lock: "session", waitFor: "300 millis" })).pipe(
          Effect.provide(sqliteFile(fixture.filename)),
          Effect.scoped,
        ),
      );
      expect(failureOf(second)).toMatchObject({ _tag: "MigrationError", reason: "locked" });
    } finally {
      await fixture.release();
      try {
        await fixture.first;
      } finally {
        await fixture.cleanup();
      }
    }
  });

  test("makeSet rejects duplicate and invalid ids listing every problem", () => {
    expect(() => makeSet([createUsers, defineMigration(1, "dup", Effect.void)])).toThrow(
      InvalidMigrationSet,
    );
    try {
      makeSet([defineMigration(0, "zero", Effect.void), defineMigration(0, "zero2", Effect.void)]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidMigrationSet);
      if (error instanceof InvalidMigrationSet) {
        expect(error.problems.length).toBeGreaterThanOrEqual(2);
      }
    }
  });
});
