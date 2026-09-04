import { describe, expect, test } from "bun:test";
import * as SqlClient from "@effect/sql/SqlClient";
import { PgClient } from "@effect/sql-pg";
import { generateSigningKey, makeAuthorizationServer } from "@structure-ai/auth";
import { type Migration, makeSet, migrationChecksum, run } from "@structure-ai/migrations";
import { SQL } from "bun";
import { Effect, Redacted } from "effect";
import {
  makeApiKeyStore,
  makeAuthStore,
  makeOAuthServerStore,
  migrate,
  migration,
  tableNames,
  upgradeMigration,
} from "../src/index.js";
import { schemaStatements, upgradeStatements } from "../src/schema.js";
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
    expect(migration(1, { tablePrefix: "x_" }).checksum).not.toBe(migration(1).checksum);
    // The base schema's statements are frozen: the v2 columns live in their
    // own migration so a recorded base checksum never drifts.
    expect(schemaStatements().join("\n")).not.toContain("family_id");
    expect(schemaStatements().join("\n")).not.toContain("last_used_step");
    expect(upgradeMigration(2).name).toBe("upgrade_auth_schema_v2");
    expect(upgradeMigration(2).checksum).toBe(
      migrationChecksum(2, "upgrade_auth_schema_v2", upgradeStatements()),
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
    const set = makeSet([migration(1, options), upgradeMigration(2, options)]);
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
          [2, `upgrade_${options.tablePrefix}schema_v2`],
        ]);
        const again = yield* run(set, { table: bookkeeping });
        expect(again).toHaveLength(0);
        // Re-running the DDL itself (outside the migrator's bookkeeping) is a no-op too.
        yield* migration(1, options).up;
        yield* upgradeMigration(2, options).up;
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
          Effect.andThen(upgradeMigration(2, clientOptions).up),
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

describe.skipIf(databaseUrl === undefined)(
  "PostgreSQL refresh-token rotation (needs DATABASE_URL)",
  () => {
    test("two concurrent refreshes of one token: exactly one succeeds and the family ends revoked", async () => {
      if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");
      const sql = new SQL(databaseUrl);
      const options = { tablePrefix: uniquePrefix() };
      await Effect.runPromise(migrate(sql, options));
      const events: Array<string> = [];
      try {
        const key = await Effect.runPromise(generateSigningKey());
        const server = makeAuthorizationServer({
          store: makeOAuthServerStore(sql, options),
          resolveTenant: () => Effect.succeed({ baseUrl: new URL("https://tenant.example.com") }),
          signingKeys: { current: key },
          registration: { signedIn: true },
          audit: { record: (event) => Effect.sync(() => void events.push(event.action)) },
        });
        const minted = await Effect.runPromise(
          server.registerClient(
            "tenant-a",
            {
              clientType: "public",
              redirectUris: ["https://agent.example.com/callback"],
              scopes: ["mcp:tools"],
            },
            { kind: "signed-in", userId: "user-1" },
          ),
        );
        const verifier = "b".repeat(64);
        const challenge = Buffer.from(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
        ).toString("base64url");
        await Effect.runPromise(
          server.grantConsent({
            tenantId: "tenant-a",
            userId: "user-1",
            clientId: minted.record.clientId,
            scope: ["mcp:tools"],
          }),
        );
        const decision = await Effect.runPromise(
          server.authorize(
            {
              tenantId: "tenant-a",
              clientId: minted.record.clientId,
              redirectUri: "https://agent.example.com/callback",
              scope: ["mcp:tools"],
              codeChallenge: challenge,
              codeChallengeMethod: "S256",
            },
            "user-1",
          ),
        );
        if (!("redirectUrl" in decision)) throw new Error("expected redirect");
        const code = new URL(decision.redirectUrl).searchParams.get("code") ?? "";
        const tokens = await Effect.runPromise(
          server.exchangeCode({
            tenantId: "tenant-a",
            clientId: minted.record.clientId,
            code: Redacted.make(code),
            codeVerifier: verifier,
            redirectUri: "https://agent.example.com/callback",
          }),
        );
        const refresh = () =>
          Effect.runPromiseExit(
            server.refresh({
              tenantId: "tenant-a",
              clientId: minted.record.clientId,
              refreshToken: Redacted.make(tokens.refreshToken ?? ""),
            }),
          );
        const outcomes = await Promise.all([refresh(), refresh()]);
        expect(outcomes.filter((exit) => exit._tag === "Success")).toHaveLength(1);
        expect(events).toEqual(["oauth-refresh-reuse"]);
        const live = await sql<Array<{ readonly live: number | string }>>`
        SELECT count(*) AS live FROM ${sql(tableNames(options).oauthTokens)}
        WHERE tenant_id = 'tenant-a' AND revoked_at IS NULL
      `;
        expect(Number(live[0]?.live)).toBe(0);
      } finally {
        for (const table of Object.values(tableNames(options)).reverse()) {
          await sql`DROP TABLE IF EXISTS ${sql(table)} CASCADE`;
        }
        await sql.close();
      }
    });
  },
);

describe.skipIf(databaseUrl === undefined)(
  "PostgreSQL recovery-code consumption (needs DATABASE_URL)",
  () => {
    test("is a compare-and-delete: a list rewritten under a held row lock is never consumed from", async () => {
      if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");
      const sql = new SQL(databaseUrl);
      const options = { tablePrefix: uniquePrefix() };
      await Effect.runPromise(migrate(sql, options));
      const store = makeAuthStore(sql, options);
      const at = new Date("2026-08-20T12:00:00.000Z");
      const totp = tableNames(options).totp;
      try {
        await Effect.runPromise(
          store.createMagicLinkUser({
            id: "user-1",
            tenantId: "tenant-a",
            email: "ada@example.com",
            emailVerified: true,
            createdAt: at,
            updatedAt: at,
          }),
        );
        await Effect.runPromise(
          store.putTotpSecret({
            tenantId: "tenant-a",
            userId: "user-1",
            secretBase32: "JBSWY3DPEHPK3PXP",
            confirmed: false,
            recoveryCodeHashes: [],
            failedAttempts: 0,
            enrolledAt: at,
          }),
        );
        await Effect.runPromise(store.confirmTotp("tenant-a", "user-1", ["hash-x", "hash-y"], at));
        // Another writer rewrites the list and holds the row lock open...
        let release: () => void = () => undefined;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const writer = sql.begin(async (tx) => {
          await tx`
          UPDATE ${tx(totp)} SET recovery_code_hashes = ${JSON.stringify(["hash-y"])}
          WHERE tenant_id = 'tenant-a' AND user_id = 'user-1'
        `;
          await held;
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        // ...while a consumer reads the old list (READ COMMITTED) and queues its
        // update behind the lock. When the lock goes, the row it compared
        // against is gone, so the consumption must not land.
        const consuming = Effect.runPromise(
          store.consumeRecoveryCode("tenant-a", "user-1", "hash-x"),
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        release();
        await writer;
        expect(await consuming).toBe(false);
        expect(
          (await Effect.runPromise(store.findTotp("tenant-a", "user-1")))?.recoveryCodeHashes,
        ).toEqual(["hash-y"]);
      } finally {
        for (const table of Object.values(tableNames(options)).reverse()) {
          await sql`DROP TABLE IF EXISTS ${sql(table)} CASCADE`;
        }
        await sql.close();
      }
    });
  },
);
