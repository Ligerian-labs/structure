/**
 * `@structure-ai/bdd` — Gherkin feature testing on `bun test`.
 *
 * `.feature` files compile into ordinary `bun test` cases: no second runner,
 * no CLI. Step definitions are typed Effect functions over a per-scenario
 * world; the framework owns eventual consistency (a drain hook runs after
 * every step), failure capture (dispatch/query record exits, never throw),
 * and loud wiring (undefined or ambiguous steps fail the suite with a
 * report). Gherkin dialects (`# language: fr`, …) work out of the box —
 * scenarios may be written in the business's language.
 */

export {
  type RecordedAuthEmail,
  registerVerifiedCustomer,
  signInPassword,
  TestAuth,
  type TestAuth as TestAuthService,
} from "./auth.js";
export {
  compileExpression,
  type ExpressionParams,
  Given,
  type StepContext,
  type StepDefinition,
  type StepHandler,
  type StepKind,
  Then,
  When,
} from "./steps.js";
export { defineFeatureSuite, type FeatureSuiteOptions } from "./suite.js";
export { DataTable, dataTableFromCells } from "./tables.js";
export { ddMmYyyyToIso, norm } from "./text.js";
export { ScenarioWorld, type WorldMissing } from "./world.js";
