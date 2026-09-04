import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { Effect } from "effect";
import {
  makeApiKeyStore,
  makeAuthStore,
  makeOAuthServerStore,
  migrate,
  tableNames,
} from "../src/index.js";
import {
  registerApiKeyScenarios,
  registerOAuthServerScenarios,
  registerStoreScenarios,
  registerTotpScenarios,
} from "./scenarios.js";

const makeHarness = async () => {
  const sql = new SQL("sqlite://:memory:");
  await Effect.runPromise(migrate(sql));
  await Effect.runPromise(migrate(sql));
  return {
    apiKeys: makeApiKeyStore(sql),
    remakeApiKeys: () => makeApiKeyStore(sql),
    store: makeAuthStore(sql),
    remake: () => makeAuthStore(sql),
    oauthServer: makeOAuthServerStore(sql),
    remakeOAuthServer: () => makeOAuthServerStore(sql),
    close: () => sql.close(),
  };
};

describe("SQLite AuthStore", () => {
  registerStoreScenarios(makeHarness);
  registerApiKeyScenarios(makeHarness);
  registerTotpScenarios(makeHarness);
  registerOAuthServerScenarios(makeHarness);
});

test("migrate adds nullable passkey metadata columns without losing existing credentials", async () => {
  const sql = new SQL("sqlite://:memory:");
  const tables = tableNames();
  try {
    await sql`
      CREATE TABLE ${sql(tables.users)} (
        tenant_id TEXT NOT NULL,
        id TEXT NOT NULL,
        email TEXT,
        email_verified INTEGER NOT NULL,
        display_name TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
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
        counter INTEGER NOT NULL,
        transports TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, credential_id)
      )
    `;
    await sql`
      INSERT INTO ${sql(tables.users)}
        (tenant_id, id, email, email_verified, created_at, updated_at)
      VALUES ('tenant-a', 'user-1', 'ada@example.com', 1, '2026-08-20T12:00:00.000Z',
        '2026-08-20T12:00:00.000Z')
    `;
    await sql`
      INSERT INTO ${sql(tables.passkeys)}
        (tenant_id, user_id, credential_id, public_key, algorithm, counter, transports, created_at)
      VALUES ('tenant-a', 'user-1', 'credential-1', 'public-key', 'ES256', 0, '[]',
        '2026-08-20T12:00:00.000Z')
    `;

    await Effect.runPromise(migrate(sql));
    await Effect.runPromise(migrate(sql));

    const columns = await sql<{ readonly name: string }[]>`
      SELECT name FROM pragma_table_info(${tables.passkeys})
    `;
    expect(columns.map((column) => column.name)).toContain("label");
    expect(columns.map((column) => column.name)).toContain("aaguid");
    expect(
      await Effect.runPromise(makeAuthStore(sql).findPasskey("tenant-a", "credential-1")),
    ).toEqual(expect.objectContaining({ credentialId: "credential-1" }));
  } finally {
    await sql.close();
  }
});
