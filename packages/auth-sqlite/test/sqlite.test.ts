import { describe } from "bun:test";
import { SQL } from "bun";
import { Effect } from "effect";
import { makeApiKeyStore, makeAuthStore, migrate } from "../src/index.js";
import { registerApiKeyScenarios, registerStoreScenarios } from "./scenarios.js";

describe("SQLite AuthStore", () => {
  registerApiKeyScenarios(async () => {
    const sql = new SQL("sqlite://:memory:");
    await Effect.runPromise(migrate(sql));
    return {
      apiKeys: makeApiKeyStore(sql),
      remakeApiKeys: () => makeApiKeyStore(sql),
      close: () => sql.close(),
      store: makeAuthStore(sql),
      remake: () => makeAuthStore(sql),
    };
  });
  registerStoreScenarios(async () => {
    const sql = new SQL("sqlite://:memory:");
    await Effect.runPromise(migrate(sql));
    await Effect.runPromise(migrate(sql));
    return {
      store: makeAuthStore(sql),
      remake: () => makeAuthStore(sql),
      apiKeys: makeApiKeyStore(sql),
      remakeApiKeys: () => makeApiKeyStore(sql),
      close: () => sql.close(),
    };
  });
});
