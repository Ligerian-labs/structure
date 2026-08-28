# ADR-0013: BDD on bun test, without adopting the Cucumber runner

- Status: accepted
- Date: 2026-08-28

## Context

Feature files are written and read by PMs and business specialists (first consumer: the Pointe Savanne booking platform, whose existing suite has 23 scenarios over `@cucumber/cucumber`'s CLI runner). Cucumber's value here is Gherkin as a business language — including French dialects — not its runner.

The existing cucumber-js setup in the consumer works but pays a tax this repo refuses: a second test runner next to `bun test`, a promise-based `World` that fights Effect's scoped resources, manual `runPromise`/`attempt` bridges and `as never` casts in every step, a mutable grab-bag world with non-null assertions, scattered manual `runWorkers()` calls to converge projections, and silent drift risk between feature files and step definitions.

## Decision

`@structure-ai/bdd` compiles `.feature` files into ordinary `bun test` cases. We use `@cucumber/gherkin` (parsing, pickles, dialects) and `@cucumber/cucumber-expressions` (matching) as libraries — the same split as ADR-0002's thin bindings — and own only the glue: suite compilation, wiring checks, and the world.

Step definitions are typed Effect functions whose parameter tuples are inferred from the expression literal; data tables decode through Effect `Schema`. Each scenario gets a fresh world built in a suite-owned scope: `ScenarioWorld<R>` dispatches commands/queries with typed exit capture (business failures never throw — `Then` steps assert them), tracks actors, and reads the event store. Eventual consistency is owned by the suite: a `drain` hook (outbox relay, projection catch-up) runs after every step by default.

Wiring is loud: undefined or ambiguous steps fail at load time with `file:line` reports; `@wip` scenarios are todo and exempt. Gherkin dialects work (`# language: fr`), so scenarios may be written in the business's language while step-definition keywords stay English (cucumber convention).

## Consequences

Easier: one runner, typed steps, PM-authored features in any dialect, converged state guaranteed under `Then`, no bridges or casts, tag filtering via `bun test --test-name-pattern`.

Harder: we own hook semantics and matcher behavior (bounded: ~400 lines); step parameters support the built-in cucumber expression types only (`{string}`, `{int}`, `{float}`, `{bigint}`, `{word}` — custom parameter types are strings); escaped braces in expression text are not modeled at the type level.

Revisit trigger: a need for cucumber ecosystem interop (formatters, CI plugins) or custom parameter-type transforms would justify extending the expression layer — still without adopting the runner.
