import { describe, expect, test } from "bun:test";
import * as SqlClient from "@effect/sql/SqlClient";
import { PgClient } from "@effect/sql-pg";
import { Cause, Deferred, Effect, Exit, Option, Redacted } from "effect";
import {
  defineMigration,
  makeSet,
  migrationsReadinessCheck,
  type RunOptions,
  run,
  status,
} from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E | undefined => {
  if (!Exit.isFailure(exit)) return undefined;
  const failure = Cause.failureOption(exit.cause);
  return Option.isSome(failure) ? failure.value : undefined;
};

/** Each runner gets its own PgClient (own pool), like separate replicas would. */
const replica = (url: string) => PgClient.layer({ url: Redacted.make(url) });

const names = () => {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  return { table: `migrations_${suffix}`, thing: `thing_${suffix}` };
};

const dropTables = (url: string, ...tables: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const table of tables) {
      yield* sql`DROP TABLE IF EXISTS ${sql(table)}`;
    }
  }).pipe(Effect.provide(replica(url)), Effect.orDie);

/**
 * A migration that signals when it starts and blocks until released, so a
 * second runner can be observed contending for the lock while the first one
 * is mid-flight.
 */
const blockingFixture = async (url: string, options: RunOptions) => {
  const { table, thing } = names();
  const entered = await Effect.runPromise(Deferred.make<void>());
  const release = await Effect.runPromise(Deferred.make<void>());
  const blocking = defineMigration(
    1,
    "create_thing",
    Effect.gen(function* () {
      yield* Deferred.succeed(entered, undefined);
      yield* Deferred.await(release);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE ${sql(thing)} (id INTEGER PRIMARY KEY)`;
    }),
    { sql: `CREATE TABLE ${thing} (id INTEGER PRIMARY KEY)` },
  );
  const set = makeSet([blocking]);
  const first = Effect.runPromise(
    run(set, { table, ...options }).pipe(Effect.provide(replica(url))),
  );
  await Effect.runPromise(Deferred.await(entered));
  return {
    set,
    table,
    first,
    release: () => Effect.runPromise(Deferred.succeed(release, undefined)),
    cleanup: () => Effect.runPromise(dropTables(url, thing, table)),
  };
};

const settlesWithin = (promise: Promise<unknown>, millis: number) =>
  Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), millis)),
  ]);

describe.skipIf(databaseUrl === undefined)("pg migrations (needs DATABASE_URL)", () => {
  const url = databaseUrl ?? "";

  /**
   * Regression: the first-ever run against a database without the bookkeeping
   * table used to abort inside the pg advisory-lock transaction. The upstream
   * Migrator bootstraps the table by probing `select '<table>'::regclass` and
   * falling back to CREATE TABLE; on Postgres that failed probe poisons the
   * surrounding transaction ("current transaction is aborted"), so `run` must
   * create the table idempotently before opening it.
   */
  test("bootstraps the bookkeeping table on a fresh database", async () => {
    const { table, thing } = names();
    const createThing = defineMigration(
      1,
      "create_thing",
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql`CREATE TABLE ${sql(thing)} (id INTEGER PRIMARY KEY)`,
      ),
    );
    const set = makeSet([createThing]);
    const program = Effect.gen(function* () {
      const applied = yield* run(set, { table });
      expect(applied.map(([id]) => id)).toEqual([1]);
      const report = yield* status(set, { table });
      expect(report.pending).toHaveLength(0);
      expect(report.applied.map((m) => m.name)).toEqual(["create_thing"]);
      const again = yield* run(set, { table });
      expect(again).toHaveLength(0);
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly checksum: string }>`SELECT checksum FROM ${sql(table)}`;
      expect(rows.map((r) => r.checksum)).toEqual([createThing.checksum]);
    }).pipe(Effect.ensuring(dropTables(url, thing, table)), Effect.provide(replica(url)));
    await Effect.runPromise(program);
  });

  test("session lock: two concurrent runners, one applies, the other waits and verifies", async () => {
    const fixture = await blockingFixture(url, { lock: "session" });
    try {
      const second = Effect.runPromise(
        run(fixture.set, { table: fixture.table, lock: "session", waitFor: "20 seconds" }).pipe(
          Effect.provide(replica(url)),
        ),
      );
      expect(await settlesWithin(second, 500)).toBe(false);
      await fixture.release();
      expect((await fixture.first).map(([id]) => id)).toEqual([1]);
      expect(await second).toHaveLength(0);
      const report = await Effect.runPromise(
        status(fixture.set, { table: fixture.table }).pipe(Effect.provide(replica(url))),
      );
      expect(report.applied.map((m) => m.id)).toEqual([1]);
      expect(report.pending).toHaveLength(0);
    } finally {
      await fixture.release();
      try {
        await fixture.first;
      } finally {
        await fixture.cleanup();
      }
    }
  });

  test("session lock: gives up with locked once waitFor elapses", async () => {
    const fixture = await blockingFixture(url, { lock: "session" });
    try {
      const second = await Effect.runPromise(
        Effect.exit(
          run(fixture.set, { table: fixture.table, lock: "session", waitFor: "300 millis" }),
        ).pipe(Effect.provide(replica(url))),
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

  test("transaction lock (default): a concurrent runner fails fast with locked", async () => {
    const fixture = await blockingFixture(url, {});
    try {
      const second = await Effect.runPromise(
        Effect.exit(run(fixture.set, { table: fixture.table })).pipe(Effect.provide(replica(url))),
      );
      expect(failureOf(second)).toMatchObject({ _tag: "MigrationError", reason: "locked" });
      // Session and transaction locks share the key: a session waiter also sees the holder.
      const waiter = await Effect.runPromise(
        Effect.exit(
          run(fixture.set, { table: fixture.table, lock: "session", waitFor: "200 millis" }),
        ).pipe(Effect.provide(replica(url))),
      );
      expect(failureOf(waiter)).toMatchObject({ _tag: "MigrationError", reason: "locked" });
    } finally {
      await fixture.release();
      try {
        await fixture.first;
      } finally {
        await fixture.cleanup();
      }
    }
  });

  test("a bookkeeping row outside the set reports unknown and fails readiness", async () => {
    const { table, thing } = names();
    const createThing = defineMigration(
      1,
      "create_thing",
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql`CREATE TABLE ${sql(thing)} (id INTEGER PRIMARY KEY)`,
      ),
    );
    const set = makeSet([createThing]);
    const program = Effect.gen(function* () {
      yield* run(set, { table });
      const sql = yield* SqlClient.SqlClient;
      // Simulates a newer artifact having migrated this database (rollback scenario).
      yield* sql`INSERT INTO ${sql(table)} (migration_id, name, checksum) VALUES (2, 'from_the_future', 'abc')`;

      const report = yield* status(set, { table });
      expect(report.applied.map((m) => m.id)).toEqual([1]);
      expect(report.pending).toHaveLength(0);
      expect(report.unknown).toEqual([{ id: 2, name: "from_the_future" }]);
      expect(report.mismatched).toHaveLength(0);

      const check = yield* migrationsReadinessCheck(set, { table });
      expect(yield* check.run).toBe(false);

      for (const lock of ["transaction", "session"] as const) {
        const exit = yield* Effect.exit(run(set, { table, lock }));
        expect(failureOf(exit)).toMatchObject({ _tag: "MigrationError", reason: "bad-state" });
      }
    }).pipe(Effect.ensuring(dropTables(url, thing, table)), Effect.provide(replica(url)));
    await Effect.runPromise(program);
  });

  test("checksum drift is detected and nothing is applied", async () => {
    const { table, thing } = names();
    const ddl = `CREATE TABLE ${thing} (id INTEGER PRIMARY KEY)`;
    const up = Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(ddl)).pipe(Effect.asVoid);
    const original = makeSet([defineMigration(1, "create_thing", up, { sql: ddl })]);
    const edited = defineMigration(1, "create_thing", up, { sql: `${ddl} -- edited` });
    const addColumn = defineMigration(
      2,
      "add_label",
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql`ALTER TABLE ${sql(thing)} ADD COLUMN label TEXT`,
      ),
    );
    const drifted = makeSet([edited, addColumn]);
    const program = Effect.gen(function* () {
      yield* run(original, { table });
      const report = yield* status(drifted, { table });
      expect(report.pending.map((m) => m.id)).toEqual([2]);
      expect(report.mismatched.map((m) => m.id)).toEqual([1]);

      for (const lock of ["transaction", "session"] as const) {
        const exit = yield* Effect.exit(run(drifted, { table, lock }));
        expect(failureOf(exit)).toMatchObject({ _tag: "MigrationError", reason: "bad-state" });
      }
      const after = yield* status(drifted, { table });
      expect(after.pending.map((m) => m.id)).toEqual([2]);
      const sql = yield* SqlClient.SqlClient;
      const columns = yield* sql<{ readonly column_name: string }>`
        SELECT column_name FROM information_schema.columns WHERE table_name = ${thing}
      `;
      expect(columns.map((c) => c.column_name)).not.toContain("label");
      const check = yield* migrationsReadinessCheck(drifted, { table });
      expect(yield* check.run).toBe(false);
    }).pipe(Effect.ensuring(dropTables(url, thing, table)), Effect.provide(replica(url)));
    await Effect.runPromise(program);
  });
});
