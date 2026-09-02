import { describe, expect, test } from "bun:test";
import * as SqlClient from "@effect/sql/SqlClient";
import { PgClient } from "@effect/sql-pg";
import { type Migration, makeSet, run } from "@structure-ai/migrations";
import { SQL } from "bun";
import { Effect, Redacted } from "effect";
import {
  makeApiKeyStore,
  makeAuthStore,
  makeOAuthServerStore,
  migrate,
  migration,
  tableNames,
} from "../src/index.js";
import {
  registerApiKeyScenarios,
  registerOAuthServerScenarios,
  registerStoreScenarios,
  registerTotpScenarios,
} from "./scenarios.js";

const databaseUrl = process.env.DATABASE_URL;

const uniquePrefix = () => `t${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}_`;

const makeHarness = async () => {
  if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");
  const sql = new SQL(databaseUrl);
  const options = { tablePrefix: uniquePrefix() };
  await Effect.runPromise(migrate(sql, options));
  await Effect.runPromise(migrate(sql, options));
  return {
    apiKeys: makeApiKeyStore(sql, options),
    remakeApiKeys: () => makeApiKeyStore(sql, options),
    store: makeAuthStore(sql, options),
    remake: () => makeAuthStore(sql, options),
    oauthServer: makeOAuthServerStore(sql, options),
    remakeOAuthServer: () => makeOAuthServerStore(sql, options),
    close: async () => {
      for (const table of Object.values(tableNames(options)).reverse()) {
        await sql`DROP TABLE IF EXISTS ${sql(table)} CASCADE`;
      }
      await sql.close();
    },
  };
};

describe.skipIf(databaseUrl === undefined)("PostgreSQL AuthStore (needs DATABASE_URL)", () => {
  registerStoreScenarios(makeHarness);
  registerApiKeyScenarios(makeHarness);
  registerTotpScenarios(makeHarness);
  registerOAuthServerScenarios(makeHarness);
});

describe("migration definition", () => {
  test("is shaped like a @structure-ai/migrations Migration", () => {
    const defined: Migration = migration(3, { tablePrefix: "x_" });
    expect(defined.id).toBe(3);
    expect(defined.name).toBe("create_x_schema");
    expect(migration(1).name).toBe("create_auth_schema");
  });
});

type Row = Record<string, unknown>;

interface SchemaSnapshot {
  readonly columns: Array<Row>;
  readonly constraints: Array<Row>;
  readonly indexes: Array<Row>;
}

/**
 * Everything Postgres knows about the tables of one prefix, with the prefix
 * normalised away so two prefixes can be compared: columns from
 * `information_schema`, constraints (pkey/unique/fk/check) and indexes from
 * `pg_catalog` (their generated names and definitions embed the table name).
 */
const snapshotSchema = async (sql: SQL, prefix: string): Promise<SchemaSnapshot> => {
  const pattern = `${prefix}%`;
  const normalise = (rows: Array<Row>) =>
    rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          typeof value === "string" ? value.replaceAll(prefix, "<prefix>") : value,
        ]),
      ),
    );
  const columns = await sql<Array<Row>>`
    SELECT table_name, column_name, ordinal_position, data_type, is_nullable,
      column_default, character_maximum_length, numeric_precision, datetime_precision
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name LIKE ${pattern}
    ORDER BY table_name, ordinal_position
  `;
  const constraints = await sql<Array<Row>>`
    SELECT c.relname AS table_name, con.conname, con.contype,
      pg_get_constraintdef(con.oid) AS definition
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname LIKE ${pattern}
    ORDER BY c.relname, con.conname
  `;
  const indexes = await sql<Array<Row>>`
    SELECT tablename, indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = current_schema() AND tablename LIKE ${pattern}
    ORDER BY tablename, indexname
  `;
  return {
    columns: normalise(columns),
    constraints: normalise(constraints),
    indexes: normalise(indexes),
  };
};

describe.skipIf(databaseUrl === undefined)("PostgreSQL auth migration (needs DATABASE_URL)", () => {
  test("joins a @structure-ai/migrations set, applies once, and serves the stores", async () => {
    if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");
    const options = { tablePrefix: uniquePrefix() };
    const bookkeeping = `${options.tablePrefix}migrations`;
    const set = makeSet([migration(1, options)]);
    const sql = new SQL(databaseUrl);
    const dropTables = Effect.gen(function* () {
      const client = yield* SqlClient.SqlClient;
      for (const table of Object.values(tableNames(options)).reverse()) {
        yield* client`DROP TABLE IF EXISTS ${client(table)} CASCADE`;
      }
      yield* client`DROP TABLE IF EXISTS ${client(bookkeeping)}`;
    }).pipe(Effect.orDie);
    try {
      const program = Effect.gen(function* () {
        const applied = yield* run(set, { table: bookkeeping });
        expect(applied).toEqual([[1, `create_${options.tablePrefix}schema`]]);
        const again = yield* run(set, { table: bookkeeping });
        expect(again).toHaveLength(0);
        // Re-running the DDL itself (outside the migrator's bookkeeping) is a no-op too.
        yield* migration(1, options).up;
      }).pipe(Effect.provide(PgClient.layer({ url: Redacted.make(databaseUrl) })));
      await Effect.runPromise(program);

      const store = makeAuthStore(sql, options);
      const now = new Date("2026-08-20T12:00:00.000Z");
      await Effect.runPromise(
        store.createMagicLinkUser({
          id: "u1",
          tenantId: "t1",
          email: "a@example.com",
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        }),
      );
      const found = await Effect.runPromise(store.findUserById("t1", "u1"));
      expect(found?.id).toBe("u1");
    } finally {
      await Effect.runPromise(
        dropTables.pipe(Effect.provide(PgClient.layer({ url: Redacted.make(databaseUrl) }))),
      );
      await sql.close();
    }
  });

  test("produces the same schema as the Bun SQL migrate", async () => {
    if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");
    const bunOptions = { tablePrefix: uniquePrefix() };
    const clientOptions = { tablePrefix: uniquePrefix() };
    const sql = new SQL(databaseUrl);
    try {
      await Effect.runPromise(migrate(sql, bunOptions));
      await Effect.runPromise(
        migration(1, clientOptions).up.pipe(
          Effect.provide(PgClient.layer({ url: Redacted.make(databaseUrl) })),
        ),
      );
      const viaBun = await snapshotSchema(sql, bunOptions.tablePrefix);
      const viaClient = await snapshotSchema(sql, clientOptions.tablePrefix);
      const tables = new Set(viaBun.columns.map((row) => row.table_name));
      expect(tables.size).toBe(Object.keys(tableNames(bunOptions)).length);
      expect(viaBun.constraints.length).toBeGreaterThan(0);
      expect(viaBun.indexes.length).toBeGreaterThan(0);
      expect(viaClient).toEqual(viaBun);
    } finally {
      for (const options of [bunOptions, clientOptions]) {
        for (const table of Object.values(tableNames(options)).reverse()) {
          await sql`DROP TABLE IF EXISTS ${sql(table)} CASCADE`;
        }
      }
      await sql.close();
    }
  });
});
