# ADR-0014: Browser E2E via subprocess app and a bearer-guarded test control plane

- Status: accepted
- Date: 2026-08-30

## Context

The framework optimizes for AI-driven development: an agent writes and maintains the application, and needs a consistent way to verify it end to end through the browser. Users bring their own frontend (any stack talking to the app's HTTP api); apps may need databases, migrations, and workers, so "just run it" is the friction point. `@structure-ai/bdd` (ADR-0013) covers business scenarios against the API through in-process worlds; it cannot exercise a real process, real sockets, real cookies, or a real UI.

Playwright's runner is Node while structure apps are Bun + Effect, so tests cannot share a process with the app without reinventing `@playwright/test`'s fixtures, retries, and traces (Playwright in library mode under bun is not a supported path). Meanwhile the things an E2E suite needs beyond clicking — seeding data, dispatching commands as a principal, converging eventual consistency, asserting on stored events — are exactly the machinery bdd owns in-process, and naive browser suites replace them with `sleep()`.

## Decision

`@structure-ai/playwright` tests the app as a real subprocess driven by `@playwright/test`. The package provides:

1. `TestControl.layer` — a second HTTP server composed only in a test entrypoint (`src/e2e-main.ts` mirroring `src/main.ts`), bearer-token guarded, exposing a **control plane**: dispatch commands/queries by registered tag with exit capture (business failures are `{ ok: false, failure: { tag, message } }` responses, never 500s), read the event store, run user-registered `drain`/`reset` hooks, and seed verified users through the real `AuthService` (recording email sender, as in bdd's `TestAuth`).
2. A plain-JavaScript, dependency-free spec-side client (subpath `@structure-ai/playwright/test`): `control.dispatch/query/events/drain/reset/auth.register`, plus `eventually(fn)` which drains the server and polls the assertion until it holds — eventual consistency stays the framework's problem, not the spec's.
3. `defineE2eConfig` — a Playwright config factory that launches backend (command + `/health/ready` wait) and frontend as `webServer`s, mints the control token, and hands URL + token to both processes via environment.

The boundary with bdd is deliberate: bdd owns business-language scenarios against the API with per-scenario worlds; playwright owns the UI against the real application. Spec files use plain promises, never Effect. The package is a dependency leaf (cqrs, eventsourcing, auth, platform) and does not touch the app's public api — the control server is a separate listener that only exists where composed.

## Consequences

Easier: agents get a uniform E2E story (one config factory, one client, one consistency helper) regardless of the app's stack; tests exercise the real process, real auth cookies, real projections; business failures stay assertable by tag like in bdd; `bdd` is untouched.

Harder: two processes must agree on port and token (solved by `defineE2eConfig` env handoff, at the cost of fixed control ports); test isolation is shared-app (unique data per test) until per-worker app instances arrive; the spec side is hand-written JS + d.ts because Node cannot execute the repo's TS-source exports (an exception to the no-build rule, kept honest by being ~200 dependency-free lines); CI needs a browser-binary job outside the network-free default suite; auth seeding requires the recording-sender composition (documented pattern, same as bdd).

Revisit trigger: per-worker app instances (Playwright projects), a declarative `@structure-ai/app-runner` for "tedious to run" apps (own ADR), or a supported Playwright-on-Bun runner would each justify revisiting the process and packaging choices.
