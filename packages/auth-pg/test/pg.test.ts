import { describe, expect, test } from "bun:test";
import * as SqlClient from "@effect/sql/SqlClient";
import { PgClient } from "@effect/sql-pg";
import { type Migration, makeSet, migrationChecksum, run } from "@structure-ai/migrations";
import { SQL } from "bun";
import { Effect, Redacted } from "effect";
import {
  makeApiKeyStore,
  makeAuthStore,
  makeOAuthServerStore,
  migrate,
  migration,
  passkeyMetadataMigration,
  tableNames,
} from "../src/index.js";
import { schemaStatements } from "../src/schema.js";
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
    // Same recipe as defineMigration with declared sql, so the migrator's
    // checksum drift detection covers the auth DDL itself.
    expect(migration(1).checksum).toBe(
      migrationChecksum(1, "create_auth_schema", schemaStatements()),
    );
    // Applied initial migrations are immutable. Add a new migration instead.
    expect(migration(1).checksum).toBe(
      "b34cc9b67c766b0a86e4721619ae1346d312b13be818916dd9af392b11d45291",
    );
    expect(migration(1, { tablePrefix: "x_" }).checksum).not.toBe(migration(1).checksum);
    const metadata = passkeyMetadataMigration(4, { tablePrefix: "x_" });
    expect(metadata.name).toBe("add_x_passkey_metadata");
    expect(metadata.checksum).toBe(
      migrationChecksum(4, metadata.name, [
        'ALTER TABLE "x_passkeys" ADD COLUMN IF NOT EXISTS label TEXT',
        'ALTER TABLE "x_passkeys" ADD COLUMN IF NOT EXISTS aaguid TEXT',
      ]),
    );
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
    const set = makeSet([migration(1, options), passkeyMetadataMigration(2, options)]);
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
        expect(applied).toEqual([
          [1, `create_${options.tablePrefix}schema`],
          [2, `add_${options.tablePrefix}passkey_metadata`],
        ]);
        const again = yield* run(set, { table: bookkeeping });
        expect(again).toHaveLength(0);
        // Re-running the DDL itself (outside the migrator's bookkeeping) is a no-op too.
        yield* migration(1, options).up;
        yield* passkeyMetadataMigration(2, options).up;
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

  test("adds nullable passkey metadata columns without losing existing credentials", async () => {
    if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");
    const options = { tablePrefix: uniquePrefix() };
    const tables = tableNames(options);
    const sql = new SQL(databaseUrl);
    try {
      await sql`
        CREATE TABLE ${sql(tables.users)} (
          tenant_id TEXT NOT NULL,
          id TEXT NOT NULL,
          email TEXT,
          email_verified BOOLEAN NOT NULL,
          display_name TEXT,
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL,
          PRIMARY KEY (tenant_id, id),
          UNIQUE (tenant_id, email)
        )
      `;
      await sql`
        CREATE TABLE ${sql(tables.passkeys)} (
          tenant_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          credential_id TEXT NOT NULL,
          public_key TEXT NOT NULL,
          algorithm TEXT NOT NULL,
          counter BIGINT NOT NULL,
          transports TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL,
          PRIMARY KEY (tenant_id, credential_id)
        )
      `;
      await sql`
        INSERT INTO ${sql(tables.users)}
          (tenant_id, id, email, email_verified, created_at, updated_at)
        VALUES ('tenant-a', 'user-1', 'ada@example.com', TRUE, NOW(), NOW())
      `;
      await sql`
        INSERT INTO ${sql(tables.passkeys)}
          (tenant_id, user_id, credential_id, public_key, algorithm, counter, transports, created_at)
        VALUES ('tenant-a', 'user-1', 'credential-1', 'public-key', 'ES256', 0, '[]', NOW())
      `;

      await Effect.runPromise(
        passkeyMetadataMigration(2, options).up.pipe(
          Effect.provide(PgClient.layer({ url: Redacted.make(databaseUrl) })),
        ),
      );
      await Effect.runPromise(
        passkeyMetadataMigration(2, options).up.pipe(
          Effect.provide(PgClient.layer({ url: Redacted.make(databaseUrl) })),
        ),
      );

      expect(
        await Effect.runPromise(
          makeAuthStore(sql, options).findPasskey("tenant-a", "credential-1"),
        ),
      ).toEqual(expect.objectContaining({ credentialId: "credential-1" }));
      const columns = await sql<{ readonly column_name: string }[]>`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = ${tables.passkeys}
      `;
      expect(columns.map((column) => column.column_name)).toContain("label");
      expect(columns.map((column) => column.column_name)).toContain("aaguid");
    } finally {
      for (const table of Object.values(tables).reverse()) {
        await sql`DROP TABLE IF EXISTS ${sql(table)} CASCADE`;
      }
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
        Effect.gen(function* () {
          yield* migration(1, clientOptions).up;
          yield* passkeyMetadataMigration(2, clientOptions).up;
        }).pipe(Effect.provide(PgClient.layer({ url: Redacted.make(databaseUrl) }))),
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
