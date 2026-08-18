import { describe } from "bun:test";
import * as SqlClient from "@effect/sql/SqlClient";
import { Effect } from "effect";
import { layer, tableNames } from "../src/index.js";
import { registerScenarios, type Scenario } from "./scenarios.js";

const databaseUrl = process.env.DATABASE_URL;

/**
 * Each scenario gets its own uniquely prefixed set of tables in the
 * database behind `DATABASE_URL`; the tables are dropped afterwards.
 */
const runTest = (scenario: Scenario): Promise<void> => {
  const tablePrefix = `t${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}_`;
  const tables = tableNames({ tablePrefix });
  const dropTables = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const table of [
      tables.events,
      tables.snapshots,
      tables.checkpoints,
      tables.outbox,
      tables.inbox,
    ]) {
      yield* sql`DROP TABLE IF EXISTS ${sql(table)}`;
    }
  }).pipe(Effect.orDie);
  return Effect.runPromise(
    scenario({ tablePrefix }).pipe(
      Effect.ensuring(dropTables),
      Effect.provide(
        layer(databaseUrl === undefined ? { tablePrefix } : { tablePrefix, url: databaseUrl }),
      ),
    ),
  );
};

describe.skipIf(databaseUrl === undefined)("pg adapters (needs DATABASE_URL)", () => {
  registerScenarios(runTest);
});
