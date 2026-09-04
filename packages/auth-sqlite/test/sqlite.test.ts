import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { Effect } from "effect";
import { makeApiKeyStore, makeAuthStore, makeOAuthServerStore, migrate } from "../src/index.js";
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

describe("SQLite schema upgrade", () => {
  test("a database created before token families and one-time steps is upgraded in place", async () => {
    const sql = new SQL("sqlite://:memory:");
    // The v1 shape of the two tables that gained columns, as 0.0.13 created them.
    await sql`
      CREATE TABLE auth_totp (
        tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, secret_base32 TEXT NOT NULL,
        confirmed INTEGER NOT NULL CHECK (confirmed IN (0, 1)), recovery_code_hashes TEXT NOT NULL,
        failed_attempts INTEGER NOT NULL CHECK (failed_attempts >= 0), locked_until TEXT,
        enrolled_at TEXT NOT NULL, PRIMARY KEY (tenant_id, user_id)
      )`;
    await sql`
      CREATE TABLE auth_oauth2_tokens (
        tenant_id TEXT NOT NULL, token_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')), client_id TEXT NOT NULL,
        user_id TEXT, scope TEXT NOT NULL, token_hash TEXT, expires_at TEXT NOT NULL,
        revoked_at TEXT, created_at TEXT NOT NULL, PRIMARY KEY (tenant_id, token_id)
      )`;
    await sql`INSERT INTO auth_totp VALUES ('t', 'u', 'JBSWY3DPEHPK3PXP', 1, '["h"]', 0, NULL, '2026-08-20T12:00:00.000Z')`;
    await Effect.runPromise(migrate(sql));
    const columns = async (table: string): Promise<Array<string>> =>
      (await sql<Array<{ name: string }>>`SELECT name FROM pragma_table_info(${table})`).map(
        (row) => row.name,
      );
    expect(await columns("auth_totp")).toContain("last_used_step");
    expect(await columns("auth_oauth2_tokens")).toEqual(
      expect.arrayContaining(["family_id", "rotated_at"]),
    );
    // The upgraded row is usable through the store, old data intact.
    const store = makeAuthStore(sql);
    const record = await Effect.runPromise(store.findTotp("t", "u"));
    expect(record?.secretBase32).toBe("JBSWY3DPEHPK3PXP");
    expect(record?.lastUsedStep).toBeUndefined();
    expect(await Effect.runPromise(store.markTotpStepUsed("t", "u", 7))).toBe(true);
    expect((await Effect.runPromise(store.findTotp("t", "u")))?.lastUsedStep).toBe(7);
    // A second migrate is a no-op.
    await Effect.runPromise(migrate(sql));
    await sql.close();
  });
});
