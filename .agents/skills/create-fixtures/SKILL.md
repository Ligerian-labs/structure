---
name: create-fixtures
description: Create and run composable base data and feature fixture scenarios in a @structure-ai application. Use when preparing data to exercise a feature, reproduce a behavior bug, or verify a business flow in development, tests or previews.
---

# Create fixtures

Use `@structure-ai/fixtures` for shared base data and named feature scenarios. Read `packages/fixtures/README.md` for the API and `packages/fixtures/test/business-app.ts` plus `business-flow.test.ts` for an executable sales/stock example. In consuming apps, use the installed package documentation and the app's existing fixture catalog.

## Workflow

1. Identify the feature's acceptance criteria and the state needed to exercise them. Find the app's existing base fixtures, scenarios, command definitions, runtime composition and readiness hooks. Reuse relevant data; the agent chooses domain-specific records and edge cases.
2. Implement or extend a named scenario. Base fixtures contain broadly required users and CMS content; feature scenarios add the specific sale, stock or other state being tested. Use ordinary typed factory functions for parameters and overrides. Decode CLI parameters with a bounded Effect Schema.
3. Use `defineFixture({ key, dependencies, create })`. Share the exact same fixture object for a shared customer or organization. Use a distinct key for a separate instance. Two different objects with the same key fail preflight; do not hide the conflict by overwriting records.
4. Inside `create`, dispatch the app's real commands and return their useful results. Preserve authorization and domain rules. Use `context.id(label)` for IDs and unique emails/slugs, and associate data with `runId` through an app-owned tenant, workspace or run association. Keep fixture keys and ID labels non-sensitive. Do not insert business rows or fabricated event history directly.
5. Add the scenario to `makeCatalog({ base, scenarios })` and mount `fixturesCommand` in the app CLI with its real layers. Resolve `enabled` from typed target configuration, false by default. Never enable it for production resources. Supply recording/test adapters for external effects. Production CMS provisioning is a separate reviewed command, with no fixture bypass.
6. Supply `ready` to drain owned work and verify query visibility. If a fixture needs a projection during creation, wait inside that fixture too. Use `Effect.void` only for synchronous apps. Supply an explicit command-based cleanup hook scoped to the run if the app supports it; preserve data for manual inspection by default.
7. Run `fixtures plan <scenario> --input '<json>'`, then `fixtures load <scenario> --input '<json>'` through the app CLI. Verify the feature using its query/API/UI or automated flow. The load receipt alone proves creation and the configured readiness hook, not the feature's behavior. For typed automated checks, pass explicit fixture roots to `run` and use `report.values`.
8. Report the scenario, exact load command and inputs, target, run ID, useful IDs or links, behavior verified and limitations. Keep credentials and personal data out of the report. On failure, inspect the receipt and completed keys; commands are not rolled back and reloading creates a new run. Do not retry blindly or reset an entire shared database.

## Verification

Add or reuse a fixture scenario that demonstrates the changed behavior. Run it against the intended isolated target, then run the relevant automated checks. A fixture that loads but does not expose the required state is incomplete. When the runtime is unavailable, report the exact blocker and leave verification incomplete.
