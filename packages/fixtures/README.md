# @structure-ai/fixtures

Composable fixture instances for business applications. Define shared base data, add named feature scenarios, and create them through the application's command bus. Use the same definitions in local development, automated tests and isolated previews.

Each invocation gets a new run UUID. Dependencies run first, shared instances run once, and data stays in the application's stores until explicitly cleaned up. The app chooses the records, persistence, authorization, external adapters and readiness checks.

## Define and compose

A fixture is one explicit instance. Use an ordinary typed function for defaults and overrides. Reuse the returned object to share it; call the function with a different key to create independent data.

```ts
import { defineFixture, defineScenario, makeCatalog, run } from "@structure-ai/fixtures";
import { Effect, Schema } from "effect";
import { RegisterCustomer, PublishPage, ReceiveStock } from "./commands.js";

const buyer = defineFixture({
  key: "base/buyer",
  create: ({ dispatch, id, runId }) => dispatch(RegisterCustomer, {
    customerId: id("customer"),
    email: `${id("customer")}@example.test`,
    fixtureRunId: runId,
  }),
});

const cms = defineFixture({
  key: "base/shipping-page",
  create: ({ dispatch, id, runId }) => dispatch(PublishPage, {
    pageId: id("page"), slug: `shipping-${id("page")}`,
    title: "Shipping information", fixtureRunId: runId,
  }),
});

const product = (key: string, quantity = 3) => defineFixture({
  key,
  dependencies: { buyer },
  create: ({ dispatch, dependencies, id, runId }) => dispatch(ReceiveStock, {
    productId: id("product"), quantity,
    ownerId: dependencies.buyer.customerId,
    fixtureRunId: runId,
  }),
});

export const catalog = makeCatalog({
  base: { buyer, cms },
  scenarios: [
    defineScenario({
      name: "base", description: "Customer and CMS content",
      input: Schema.Struct({}), fixtures: () => ({}),
    }),
    defineScenario({
      name: "sales/stock", description: "Products ready for a sale",
      input: Schema.Struct({
        quantity: Schema.optionalWith(
          Schema.Number.pipe(Schema.int(), Schema.between(1, 100)),
          { default: () => 3 },
        ),
      }),
      fixtures: ({ quantity }) => ({ product: product("sales/product", quantity) }),
    }),
  ],
});
```

The commands above are application-owned examples. Use your actual schemas and model a run namespace through an existing tenant, workspace or another owned association when possible. `fixtureRunId` is illustrative, not a framework-required command field.

`context.id(label)` produces a UUID stable within one fixture instance and invocation. It changes on the next invocation. Use it for all unique IDs, emails, slugs and idempotency keys. For schema-branded IDs, decode through the application's ID schema where necessary. Fixed business values such as prices, dates and quantities remain under the fixture author's control. There is no Faker dependency, implicit random data generation or production-data importer.

## Run and verify

Direct composition preserves typed outputs and the Effect service requirements of every dependency:

```ts
const fixtures = { buyer, cms, product: product("sales/product", 2) };
const seeded = run({
  fixtures,
  enabled: settings.fixturesEnabled,
  timeoutMs: 30_000,
  ready: () => drainAndVerifyReadModels,
});
// Provide the application's CommandBus and other required services to seeded.
// Its result.values.product has the ReceiveStock command's success type.
```

For a named scenario, call `catalog.prepare("sales/stock", { quantity: 2 })`, then pass the resulting roots to `run`. Catalog outputs are heterogeneous, so their values are `unknown`; use direct composition when a test needs typed outputs. Builders must be pure: decode input and construct fixture definitions, performing all effects inside `create`.

Preflight checks the whole dependency graph before any fixture commands run. Different objects with the same fixture key are an error, even if their configuration happens to match. Root alias conflicts, cycles, invalid names and unknown scenarios fail explicitly. Base fixtures are included first; explicit dependencies always determine execution order. Execution is sequential with no automatic retries or cross-command transaction.

`ready` is required. Drain owned outbox/consumer work and catch up projections, then check relevant queries where needed. Pass `() => Effect.void` only when the app has no asynchronous work to wait for. A fixture that depends on a projected value during creation must wait for that value itself; the final readiness hook runs after all fixture instances. Do not sleep for an arbitrary duration.

A successful report contains `runId`, `completed` fixture keys, typed `values`, and generated `ids` grouped by fixture key and label. A failed run returns `FixtureError` with its run ID, failed step, completed keys and underlying `Cause`. Completed data and any partial work inside the failed command remain available. The message omits command payloads and raw causes. Interruption stays an interruption; the CLI's progress receipt still identifies the run. The default 30-second deadline includes readiness and can be changed by the application.

## Application CLI

Mount the group in the app's CLI so it uses the app's configured services:

```ts
import { Command, defineCommand, runCli, withSubcommands } from "@structure-ai/cli";
import { fixturesCommand } from "@structure-ai/fixtures/cli";
import { Effect } from "effect";
import { catalog } from "./fixtures.js";
import { appLayer, settings, drainAndVerifyReadModels, removeFixtureRun } from "./app.js";

const root = withSubcommands(
  defineCommand({ name: "shop", handler: () => Effect.void }),
  [fixturesCommand(catalog, {
    enabled: settings.fixturesEnabled,
    ready: () => drainAndVerifyReadModels,
    cleanup: removeFixtureRun,
    timeoutMs: 60_000,
  })],
).pipe(Command.provide(appLayer));

runCli({ name: "shop", version: "1.0.0", root });
```

```sh
bun src/cli.ts fixtures list
bun src/cli.ts fixtures plan sales/stock --input '{"quantity":2}'
bun src/cli.ts fixtures load sales/stock --input '{"quantity":2}'
bun src/cli.ts fixtures cleanup <run-id>
```

`list` and `plan` are read-only and work with fixtures disabled. `--input` defaults to `{}` and is decoded against the selected scenario's schema. Unknown properties are rejected. Define limits for counts and other expensive parameters in that schema. Do not pass secrets in CLI inputs.

Successful subcommands emit JSON on stdout. `load` prints progress receipts on stderr and returns the scenario, run ID, completed keys and generated IDs on stdout. It never prints raw fixture outputs. Keep names and ID labels static and non-sensitive. IDs allocated by a command itself are available in programmatic outputs; only IDs requested through `context.id` appear in the CLI receipt. Standard framework exit codes apply: permanent/conflict failures 1, transient failures and run deadlines 75, argument errors 64, interruption 130.

The app owns `cleanup(runId)`. Implement it through commands that remove or archive only that run's resources, then wait for deletion to become visible. It must be safe after partial creation and should support repeated cleanup. Omit the hook if the domain has no removal workflow; the CLI reports that cleanup is unavailable. The library validates the run UUID but does not maintain a durable registry of runs or prove ownership. The app's command must enforce that ownership. There is no global reset or automatic rollback.

## Targets and production

Fixture mutation is disabled unless the app supplies `enabled: true`. Load this capability from typed target configuration with a false default. Keep it disabled for every production target and exclude the fixture CLI composition from production entrypoints. There is no `--force`, environment-name inference or production CMS override. This is an application composition guard, not a credential detector: the application owns the connection targets and must not grant the capability against production resources.

Provide the real application buses and authorization policy. Fixture dispatch uses the same validation, authorization and domain rules as normal commands. Pass `actor` or other normal dispatch options when required by the app. Provide recording/test adapters for emails, payments and other external effects. Use the existing auth setup recipe where a real account and verified session are needed.

Production CMS initialization should be a separate, reviewed, repeatable provisioning command with its own deployment policy. It can reuse content definitions with fixtures, but must not enable development fixture execution.

Durability follows the provided app layers. A CLI using a durable database leaves data available to the app after the process exits. In-memory test layers retain data only for their process/layer lifetime. Fresh IDs isolate new fixture records; they do not isolate global singleton settings, third-party side effects or a shared database by themselves. Use a dedicated tenant, workspace or database where the domain requires stronger isolation.

## Exports

| Export | Contract |
| --- | --- |
| `defineFixture({ key, dependencies?, create })` | One explicit instance; typed dependency outputs and service requirements. |
| `defineScenario({ name, description, input, fixtures })` | Schema-decoded inputs and a pure builder for named feature roots. |
| `makeCatalog({ base, scenarios })` | Shared base roots, `list` and `prepare(name, input?)`. |
| `plan(fixtures)` | Validated dependency order without writes. |
| `run({ fixtures, enabled?, ready, timeoutMs?, onProgress? })` | Fresh run, retained data, typed outputs, readiness and completion receipt. |
| `cleanup({ runId, enabled?, remove, timeoutMs? })` | Explicit, guarded application cleanup hook. |
| `FixtureError` | Classified failure with safe message and optional run context/cause. |
| `Fixture`, `Fixtures`, `FixtureContext`, `Values`, `Requirements`, `Errors` | Composition types. |
| `Scenario`, `Catalog`, `RunOptions`, `RunProgress`, `RunReport` | Scenario and lifecycle contracts. |
| `fixturesCommand(catalog, options)` from `./cli` | Mountable CLI group; `FixturesCommandOptions` describes readiness and cleanup. |

Dependencies: `effect` and `@structure-ai/cqrs`; the `./cli` subpath uses `@structure-ai/cli`. No SQL adapter or test-runner dependency is required by the core.

## Executable example

[`test/business-app.ts`](test/business-app.ts) defines shared user/CMS fixtures and `sales/low-stock`, backed by real CQRS handlers, a stock decider and a deferred query model. [`test/business-flow.test.ts`](test/business-flow.test.ts) loads it, verifies the query, exercises the overselling rule and cleans one run without affecting another.

```sh
# From packages/fixtures
bun test test/business-flow.test.ts
bun test/example-cli.ts fixtures list
bun test/example-cli.ts fixtures load sales/low-stock --input '{"remaining":2}'
```

The example CLI uses process-local stores for demonstration. Copy the composition into your app and provide its durable layers for manual exploration. For the agent workflow, see [create-fixtures](../../.agents/skills/create-fixtures/SKILL.md).
