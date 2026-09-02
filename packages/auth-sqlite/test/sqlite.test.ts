import { describe } from "bun:test";
import { SQL } from "bun";
import { Effect } from "effect";
import { makeApiKeyStore, makeAuthStore, migrate } from "../src/index.js";
import {
  registerApiKeyScenarios,
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
    close: () => sql.close(),
  };
};

describe("SQLite AuthStore", () => {
  registerStoreScenarios(makeHarness);
  registerApiKeyScenarios(makeHarness);
  registerTotpScenarios(makeHarness);
});
