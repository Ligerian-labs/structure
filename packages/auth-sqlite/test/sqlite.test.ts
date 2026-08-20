import { describe } from "bun:test";
import { SQL } from "bun";
import { Effect } from "effect";
import { makeAuthStore, migrate } from "../src/index.js";
import { registerStoreScenarios } from "./scenarios.js";

describe("SQLite AuthStore", () => {
  registerStoreScenarios(async () => {
    const sql = new SQL("sqlite://:memory:");
    await Effect.runPromise(migrate(sql));
    await Effect.runPromise(migrate(sql));
    return {
      store: makeAuthStore(sql),
      remake: () => makeAuthStore(sql),
      close: () => sql.close(),
    };
  });
});
