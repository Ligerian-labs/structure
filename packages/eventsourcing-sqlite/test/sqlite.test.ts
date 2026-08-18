import { describe } from "bun:test";
import { Effect } from "effect";
import { layer } from "../src/index.js";
import { registerScenarios, type Scenario } from "./scenarios.js";

/** Each scenario gets its own fresh in-memory database, unprefixed tables. */
const runTest = (scenario: Scenario): Promise<void> =>
  Effect.runPromise(scenario().pipe(Effect.provide(layer({ filename: ":memory:" }))));

describe("sqlite adapters", () => {
  registerScenarios(runTest);
});
