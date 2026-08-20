import { describe } from "bun:test";
import { SQL } from "bun";
import { Effect } from "effect";
import { makeAuthStore, migrate, tableNames } from "../src/index.js";
import { registerStoreScenarios } from "./scenarios.js";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(databaseUrl === undefined)("PostgreSQL AuthStore (needs DATABASE_URL)", () => {
  registerStoreScenarios(async () => {
    if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");
    const sql = new SQL(databaseUrl);
    const tablePrefix = `t${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}_`;
    const options = { tablePrefix };
    await Effect.runPromise(migrate(sql, options));
    await Effect.runPromise(migrate(sql, options));
    return {
      store: makeAuthStore(sql, options),
      remake: () => makeAuthStore(sql, options),
      close: async () => {
        const tables = tableNames(options);
        for (const table of Object.values(tables).reverse()) {
          await sql`DROP TABLE IF EXISTS ${sql(table)} CASCADE`;
        }
        await sql.close();
      },
    };
  });
});
