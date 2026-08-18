import { describe, expect, test } from "bun:test";
import * as SqlClient from "@effect/sql/SqlClient";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Effect, Exit } from "effect";
import { defineMigration, InvalidMigrationSet, makeSet, run, status } from "../src/index.js";

const sqlite = () => SqliteClient.layer({ filename: ":memory:" });

const createUsers = defineMigration(
  1,
  "create_users",
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT)`,
  ),
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
      expect(report.applied.map((m) => m.name)).toEqual([
        "create_users",
        "add_email",
        "seed_admin",
      ]);
    });
    await Effect.runPromise(program.pipe(Effect.provide(sqlite()), Effect.scoped));
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
    });
    await Effect.runPromise(program.pipe(Effect.provide(sqlite()), Effect.scoped));
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
