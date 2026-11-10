import { describe } from "bun:test";
import { layer as eventsourcingLayer } from "@structure-ai/eventsourcing-dynamodb";
import { Effect, Redacted } from "effect";
import { makeAuthStore } from "../src/index.js";
import { registerStoreScenarios, type StoreHarness } from "./scenarios.js";

/**
 * Runs the AuthStore scenarios against DynamoDB Local behind
 * `DYNAMODB_ENDPOINT_URL` (skipped otherwise). The eventsourcing layer
 * creates the shared table (as in real compositions); the auth store needs
 * no extra indexes — every lookup is a designed key.
 */
const endpoint = process.env.DYNAMODB_ENDPOINT_URL;

describe.skipIf(endpoint === undefined)("auth-dynamodb (needs DYNAMODB_ENDPOINT_URL)", () => {
  registerStoreScenarios(async () => {
    const tableName = `auth_test_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const live = eventsourcingLayer({
      tableName,
      region: "local",
      endpoint: endpoint ?? "",
      accessKeyId: "local",
      secretAccessKey: Redacted.make("local"),
    });
    const store = await Effect.runPromise(Effect.provide(makeAuthStore({ tableName }), live));
    const harness: StoreHarness = {
      store,
      // Same table, fresh store handle: the data must survive the "remake".
      remake: () => store,
      close: async () => {},
    };
    return harness;
  });
});
