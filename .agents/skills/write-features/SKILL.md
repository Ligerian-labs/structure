---
name: write-features
description: Write and wire Gherkin feature tests (BDD) in a @structure-based app - .feature files, step definitions, per-scenario worlds, drain hooks, failure assertions. Use when adding behavior-driven scenarios or a feature suite.
---

# Write feature tests (BDD)

Use `@structure-ai/bdd` to compile `.feature` files into `bun test` cases. PMs/business specialists write the features; developers write the step definitions and the world. Design contract: [ADR-0013](../../../docs/decisions/0013-bdd-on-bun-test.md).

## Layout

```
test/
├── features/**/*.feature   # business language, any Gherkin dialect
├── steps/*.steps.ts        # typed step definitions
├── composition.ts          # buildTestWorld + drain
└── features.test.ts        # defineFeatureSuite wiring
```

## Steps

1. **World** — subclass `ScenarioWorld<R>`; add typed scenario state (doubles, last results). `buildTestWorld(scope)` mirrors the `serveTest` composition with every durable port doubled (in-memory stores, recording mailer, mutable catalog); build the layer into the passed scope and return `new MyWorld(scope, context)`.
2. **Steps** — `Given/When/Then(expression, handler)`; handler receives `{ world, params, table?, doc? }`. Params are typed from the expression (`{string}` → `string`, `{int}` → `number`). Tables decode via `table.rows(Schema.Struct({...}))`. Return an Effect (piped through `world.use`), a promise, or nothing.
3. **Suite** — `defineFeatureSuite({ features: "test/features/**/*.feature", makeWorld, steps, drain })` from a `test/features.test.ts` file; it registers ordinary `bun test` cases.
4. **Drain** — eventual consistency is the suite's job: pass `drain: (world) => world.use(runWorkers)` (outbox relay + projection catch-up); it runs after every step. `drainAfterStep: false` opts out for manual control.
5. **Run** — `bun test test/features.test.ts`; filter by tag with `--test-name-pattern "@booking"`.

## Conventions

- **Asserting failures**: dispatch/query/attempt record exits — never throw on business errors. `Then` steps call `world.expectFailure("Backordered")` / `expectFailure("ValidationFailed", "end date")`; successes via `world.expectSuccess()` and the typed value the step captured. `world.attempt(effect)` extends the same capture to non-bus calls (auth service, ports).
- **Actors**: `world.signIn(email, userId)` in a `Given`, dispatches run as `world.currentActor`.
- **Auth flows**: use the auth kit — `TestAuth.make({ tenantId, baseUrl })` once per world (real `AuthService` over in-memory store, recorded e-mails with unwrapped tokens), `registerVerifiedCustomer({ testAuth, email, password })` for the register-verify-sign-in `Given`, `signInPassword` for fixture sign-ins, and raw service calls through `world.attempt` when a scenario asserts a tagged auth failure (`InvalidCredentials`, ...).
- **Money/dates in features**: use the shipped conventions — `norm()` for locale-safe comparison (fr-FR money emits narrow no-break spaces) and `ddMmYyyyToIso()` for the dd/MM/yyyy table convention. Express absence in tables with `NULL` + `table.rows(schema, { nullLiteral: "NULL" })`.
- **Business steps stay business-y**: app-specific English (or French) sentences bound to typed commands; do not expose `{json}` payloads or command tags to feature files.
- **Wiring is loud**: an undefined or ambiguous step fails the suite at load with `file:line`; there are no silent skips. `@wip` scenarios are todo and exempt.
- **Dialects**: `# language: fr` at the top of a feature; step-definition keywords stay `Given/When/Then`.

## Working example

`packages/bdd/test/` — a reservation fixture app (event-sourced command, outbox-driven mails, projection-backed query) with English and French features, outlines, tables, doc strings, tags, and failure scenarios. The package README documents the full API.
