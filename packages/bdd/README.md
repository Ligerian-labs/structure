# @structure-ai/bdd

Gherkin feature testing on `bun test`: business-readable scenarios (written by PMs, business specialists, developers — in any Gherkin dialect) compile into ordinary `bun test` cases. No second runner, no CLI, no generated code. Step definitions are typed Effect functions over a per-scenario world; the framework owns eventual consistency and failure capture so scenarios state business outcomes, not plumbing.

## Usage

```
apps/my-api/
├── test/
│   ├── features/            # .feature files — the business writes these
│   │   └── booking/
│   │       └── quotation.feature
│   ├── steps/               # step definitions — developers write these
│   │   └── booking.steps.ts
│   ├── composition.ts       # buildTestWorld: in-memory composition
│   └── features.test.ts     # the suite — one file, three lines of wiring
```

```ts
// test/features.test.ts
import { defineFeatureSuite } from "@structure-ai/bdd";
import { buildTestWorld, runWorkers } from "./composition.ts";
import { bookingSteps } from "./steps/booking.steps.ts";

defineFeatureSuite({
  features: "test/features/**/*.feature",
  makeWorld: buildTestWorld,
  steps: bookingSteps,
  drain: (world) => world.use(runWorkers),
});
```

`bun test` now runs the scenarios; `bun test --test-name-pattern "@booking"` filters by tag. Scenarios tagged `@wip` are registered as todo (and exempt from wiring checks).

## Feature files

Standard Gherkin — Feature, Background, Scenario, Scenario Outline + Examples, data tables, doc strings, tags — in any dialect (`# language: fr` gives `Fonctionnalité`, `Soit`, `Plan du Scénario`, …). Business specialists write and read these:

```gherkin
# language: fr
Fonctionnalité: Tarifs
  Contexte:
    Soit un tarif de 300 € par nuit pour la villa "savanne"

  Plan du Scénario: Total pour <nuits> nuits
    Quand le client demande une réservation de <nuits> nuits à partir du "2026-07-01"
    Alors le total est de "<total>"
    Exemples:
      | nuits | total      |
      | 7     | 2 100,00 € |
```

## Step definitions

Typed Effect functions; parameters are inferred from the cucumber expression (`{string}` → `string`, `{int}`/`{float}` → `number`, `{bigint}` → `bigint`, anything else → `string`); data tables decode through Effect `Schema`:

```ts
import { Effect, Schema } from "effect";
import { Given, Then, When } from "@structure-ai/bdd";

const customerRow = Schema.Struct({ email: Schema.String });

export const bookingSteps = [
  Given("registered customers:", ({ world, table }) =>
    world.use(Effect.gen(function* () {
      const rows = table !== undefined ? yield* table.rows(customerRow) : [];
      for (const row of rows) world.signIn(row.email, `user-${row.email}`);
    }))),

  When("the customer submits the QuotationRequest", ({ world }) =>
    world.use(submitCurrentQuotation(world))),

  Then('an exception {string} should be thrown with message {string}', ({ world, params }) => {
    const [tag, message] = params as readonly [string, string];
    world.expectFailure(tag, message);
  }),
];
```

## The world

One fresh world per scenario, built inside a suite-owned `Scope` (in-memory stores, buses, doubles — mirror your `serveTest` composition) and torn down afterwards. Subclass `ScenarioWorld<R>` with typed scenario state; the base class provides the machinery:

| Member | What it does |
| --- | --- |
| `dispatch(command, payload, { actor, idempotencyKey })` | Dispatches on the `CommandBus` and **records the exit** — business failures never throw, `Then` steps assert them. Requires `CommandBus` in `R`. |
| `query(queryDef, payload)` | Same for queries (`QueryBus` in `R`). |
| `expectSuccess()` / `expectFailure(tag, message?)` | Assert the last outcome; throw (fail the scenario) on mismatch. |
| `failureTags()` | `_tag`s of every recorded failure, in order. |
| `events()` | Every stored event, in global order (`EventStore` in `R`). |
| `signIn(name, id)` / `actorNamed(name)` / `currentActor` | The scenario's principal registry — `dispatch` steps run as the current actor. |
| `use(effect)` | Provides the world's services to any app effect. |

Eventual consistency is the framework's problem: a `drain` hook (outbox relay, projection catch-up) runs **after every step** by default, so `Then` steps always observe converged state. Disable per suite (`drainAfterStep: false`) and drain manually from steps if a scenario needs finer control.

## Loud wiring

A feature file is a contract: every step must match exactly one definition. Suites with undefined or ambiguous steps fail at load time with a full report (`file:line`, step text, candidate expressions) — silent skips are impossible.

## Exports

| Export | What it is |
| --- | --- |
| `defineFeatureSuite(options)` | Compiles `.feature` files into `bun test` cases. |
| `Given` / `When` / `Then` | Register step definitions; params typed from the expression literal. |
| `ScenarioWorld<R>` | Base world: typed dispatch/query with exit capture, actors, events, `use`. |
| `DataTable` | `hashes()` raw rows; `rows(Schema.Struct)` typed decode. |
| `ExpressionParams<S>` | The parameter tuple derived from an expression literal (type-level). |

Dependencies: `@cucumber/gherkin` (parser + pickles, dialects), `@cucumber/cucumber-expressions` (matching) — libraries, not a runner. The fixture app under `test/` is a full working example (event store, outbox-driven mails, projection-backed query, business failures, a French feature with an outline); its features are the package's own test suite.
