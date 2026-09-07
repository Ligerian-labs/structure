/**
 * The schema as versioned steps: rev 1 is the table set as it shipped up
 * to 0.0.14, rev 2 adds the generated `partition` column and its index on
 * `events`. `migrate()` applies every step in order and is idempotent.
 *
 * Runs against `DATABASE_URL` only (see pg.test.ts).
 */
import { describe, expect, test } from "bun:test";
import * as SqlClient from "@effect/sql/SqlClient";
import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted } from "effect";
import { type AdapterOptions, migrate, migrations, tableNames } from "../src/index.js";
import { testMetadata } from "./fixtures.js";

const databaseUrl = process.env.DATABASE_URL;

interface ColumnRow {
  readonly column_name: string;
  readonly is_generated: string;
  readonly generation_expression: string | null;
}

interface IndexRow {
  readonly indexname: string;
  readonly indexdef: string;
}

interface PartitionRow {
  readonly position: number | bigint | string;
  readonly partition: string | null;
}

const step = (rev: number) => {
  const found = migrations.find((migration) => migration.rev === rev);
  if (found === undefined) {
    throw new Error(`no migration step with rev ${rev}`);
  }
  return found;
};

const partitionColumn = (events: string) =>
  Effect.map(
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) => sql<ColumnRow>`
        SELECT column_name, is_generated, generation_expression
        FROM information_schema.columns
        WHERE table_name = ${events} AND column_name = 'partition'
      `,
    ),
    (rows) => rows,
  );

const partitionIndex = (events: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<IndexRow>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = ${events} AND indexname = ${`${events}_partition_position_idx`}
    `,
  );

const insertEvent = (events: string, streamName: string, version: number, partition?: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => {
    const metadata = JSON.stringify(
      partition === undefined ? testMetadata(version) : { ...testMetadata(version), partition },
    );
    return sql`
      INSERT INTO ${sql(events)} (stream_name, version, type, schema_version, payload, metadata)
      VALUES (${streamName}, ${version}, 'Incremented', 1, '{}'::jsonb, ${metadata}::jsonb)
    `;
  });

const runTest = (
  scenario: (options: AdapterOptions) => Effect.Effect<void, unknown, SqlClient.SqlClient>,
): Promise<void> => {
  const tablePrefix = `t${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}_`;
  const tables = tableNames({ tablePrefix });
  const dropTables = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const table of Object.values(tables)) {
      yield* sql`DROP TABLE IF EXISTS ${sql(table)}`;
    }
  }).pipe(Effect.orDie);
  return Effect.runPromise(
    scenario({ tablePrefix }).pipe(
      Effect.ensuring(dropTables),
      Effect.provide(
        PgClient.layer(databaseUrl === undefined ? {} : { url: Redacted.make(databaseUrl) }),
      ),
    ),
  );
};

describe.skipIf(databaseUrl === undefined)("pg schema migration steps (needs DATABASE_URL)", () => {
  test("migrations are rev 1 (the 0.0.14 tables) and rev 2 (partition column + index), in order", () => {
    expect(migrations.map((migration) => migration.rev)).toEqual([1, 2]);
    for (const migration of migrations) {
      expect(migration.name.length).toBeGreaterThan(0);
    }
  });

  test("rev 2 on a table already holding events: old rows NULL, new rows populated, index present", () =>
    runTest((options) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const tables = tableNames(options);
        yield* step(1).apply(options);
        yield* insertEvent(tables.events, "Counter-old", 1);
        yield* insertEvent(tables.events, "Counter-old", 2, "stamped-before-rev-2");
        expect(yield* partitionColumn(tables.events)).toEqual([]);
        expect(yield* partitionIndex(tables.events)).toEqual([]);

        yield* step(2).apply(options);

        const columns = yield* partitionColumn(tables.events);
        expect(columns.length).toBe(1);
        expect(columns[0]?.is_generated).toBe("ALWAYS");
        expect(columns[0]?.generation_expression).toContain("'partition'");
        const indexes = yield* partitionIndex(tables.events);
        expect(indexes.length).toBe(1);
        // partition must LEAD the index: an equality on the filter column
        // then a range on position is what serves readAll({ partition })
        expect(indexes[0]?.indexdef).toMatch(/\(partition, "?position"?\)/);

        yield* insertEvent(tables.events, "Counter-new", 1, "agency-42");
        yield* insertEvent(tables.events, "Counter-new", 2);
        const rows = yield* sql<PartitionRow>`
          SELECT position, partition FROM ${sql(tables.events)} ORDER BY position
        `;
        expect(rows.map((row) => row.partition)).toEqual([
          null,
          "stamped-before-rev-2",
          "agency-42",
          null,
        ]);
        // the rewritten column is what the filter reads
        const filtered = yield* sql<PartitionRow>`
          SELECT position, partition FROM ${sql(tables.events)}
          WHERE partition = 'agency-42' ORDER BY position
        `;
        expect(filtered.map((row) => String(row.position))).toEqual(["3"]);
      }),
    ));

  test("migrate() on a fresh database reaches the same end state, and twice is a no-op", () =>
    runTest((options) =>
      Effect.gen(function* () {
        const tables = tableNames(options);
        yield* migrate(options);
        const columns = yield* partitionColumn(tables.events);
        expect(columns.length).toBe(1);
        expect(columns[0]?.is_generated).toBe("ALWAYS");
        expect((yield* partitionIndex(tables.events)).length).toBe(1);
        yield* insertEvent(tables.events, "Counter-fresh", 1, "agency-1");

        yield* migrate(options);

        expect((yield* partitionColumn(tables.events)).length).toBe(1);
        expect((yield* partitionIndex(tables.events)).length).toBe(1);
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<PartitionRow>`
          SELECT position, partition FROM ${sql(tables.events)} ORDER BY position
        `;
        expect(rows.map((row) => row.partition)).toEqual(["agency-1"]);
      }),
    ));
});
