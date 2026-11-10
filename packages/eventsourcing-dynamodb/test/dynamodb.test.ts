import { describe } from "bun:test";
import { Effect, Redacted } from "effect";
import { layer } from "../src/index.js";
import { registerScenarios, type Scenario } from "./scenarios.js";

/**
 * Runs the adapter suite against DynamoDB Local (or any endpoint behind
 * `DYNAMODB_ENDPOINT_URL`); skipped otherwise, mirroring the pg adapters'
 * `DATABASE_URL` pattern. Each scenario gets a fresh table — names are unique
 * per run, so an ephemeral local database accumulates them harmlessly.
 */
const endpoint = process.env.DYNAMODB_ENDPOINT_URL ?? "";

describe.skipIf(process.env.DYNAMODB_ENDPOINT_URL === undefined)(
  "dynamodb adapters (needs DYNAMODB_ENDPOINT_URL)",
  () => {
    registerScenarios((scenario: Scenario) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const tableName = `structure_test_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
            const live = layer({
              tableName,
              region: "local",
              endpoint,
              accessKeyId: "local",
              secretAccessKey: Redacted.make("local"),
            });
            yield* Effect.provide(scenario({ tableName }), live);
          }),
        ),
      ),
    );
  },
);
