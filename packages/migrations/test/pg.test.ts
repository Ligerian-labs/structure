import { describe, expect, test } from "bun:test";
import * as SqlClient from "@effect/sql/SqlClient";
import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted } from "effect";
import { defineMigration, makeSet, run, status } from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;

/**
 * Regression: the first-ever run against a database without the bookkeeping
 * table used to abort inside the pg advisory-lock transaction. The upstream
 * Migrator bootstraps the table by probing `select '<table>'::regclass` and
 * falling back to CREATE TABLE; on Postgres that failed probe poisons the
 * surrounding transaction ("current transaction is aborted"), so `run` must
 * create the table idempotently before opening it.
 */
describe.skipIf(databaseUrl === undefined)("pg migrations (needs DATABASE_URL)", () => {
  test("bootstraps the bookkeeping table on a fresh database", async () => {
    if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const table = `migrations_${suffix}`;
    const thing = `thing_${suffix}`;
    const set = makeSet([
      defineMigration(
        1,
        "create_thing",
        Effect.flatMap(
          SqlClient.SqlClient,
          (sql) => sql`CREATE TABLE ${sql(thing)} (id INTEGER PRIMARY KEY)`,
        ),
      ),
    ]);
    const dropTables = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP TABLE IF EXISTS ${sql(thing)}`;
      yield* sql`DROP TABLE IF EXISTS ${sql(table)}`;
    }).pipe(Effect.orDie);

    const program = Effect.gen(function* () {
      const applied = yield* run(set, { table });
      expect(applied.map(([id]) => id)).toEqual([1]);
      const report = yield* status(set, { table });
      expect(report.pending).toHaveLength(0);
      expect(report.applied.map((m) => m.name)).toEqual(["create_thing"]);
      const again = yield* run(set, { table });
      expect(again).toHaveLength(0);
    }).pipe(
      Effect.ensuring(dropTables),
      Effect.provide(PgClient.layer({ url: Redacted.make(databaseUrl) })),
    );
    await Effect.runPromise(program);
  });
});
