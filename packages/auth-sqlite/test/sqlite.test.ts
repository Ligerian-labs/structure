import { describe } from "bun:test";
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
