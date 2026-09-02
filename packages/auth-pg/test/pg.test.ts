import { describe } from "bun:test";
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

const databaseUrl = process.env.DATABASE_URL;

const makeHarness = async () => {
  if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");
  const sql = new SQL(databaseUrl);
  const options = { tablePrefix: `t${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}_` };
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
