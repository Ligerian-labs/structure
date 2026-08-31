# @structure-ai/playwright

Browser E2E for structure apps on `@playwright/test`: specs drive the **real application subprocess** (real sockets, real cookies, real projections) through the user's own frontend, while a bearer-guarded **test control plane** gives them everything `@structure-ai/bdd` worlds have in-process — seeding, dispatch by tag, event-store reads, drain for eventual consistency, and auth user seeding.

`bdd` owns business scenarios against the API; this package owns the UI against the running application (ADR-0014).

## The three pieces

1. **`defineE2eConfig`** (spec side) — a Playwright config factory: launches backend (`bun src/e2e-main.ts`, waiting on `/health/ready`) and the frontend as `webServer`s, mints the control token, and hands port + token to both processes via the environment.
2. **`TestControl.layer`** (app side) — a second HTTP server composed **only in a test entrypoint**, guarded by a bearer token: dispatch commands/queries by registry key or message tag with exit capture (business failures arrive as `{ ok: false, failure: { tag, message } }`, never 500s), read the event store, run `drain`/`reset` hooks, and seed verified users through the real `AuthService`.
3. **The spec client** (`@structure-ai/playwright/test`, plain JavaScript, zero dependencies) — `control.dispatch/query/events/drain/reset`, `control.auth.register`, and `eventually(fn)` which drains the server and polls the assertion until it holds.

## Usage

```ts
// playwright.config.ts
import { defineConfig } from "@playwright/test";
import { defineE2eConfig } from "@structure-ai/playwright/test";

export default defineConfig({
  testDir: "test/e2e",
  ...defineE2eConfig({
    backend: {
      command: "bun src/e2e-main.ts",
      url: "http://127.0.0.1:3000/health/ready",
    },
    frontend: {
      command: "bun run frontend dev",
      url: "http://127.0.0.1:5173",
    },
  }),
});
```

```ts
// src/e2e-main.ts — the test entrypoint mirroring src/main.ts, plus the control plane
import { TestControl } from "@structure-ai/playwright";

const { port, token } = TestControl.fromEnv();

const ControlLive = TestControl.layer({
  port,
  token,
  commands: { placeOrder: PlaceOrder },   // registry keys; specs may also use tags ("PlaceOrder")
  queries: { listOrders: ListOrders },
  drain: runWorkers,                       // outbox relay + projection catch-up
  auth: authStack,                         // RecordingAuth.make(...) — enables control.auth.register
});
// Layer.provide with the app composition, merge next to serve().
```

```ts
// test/e2e/orders.e2e.ts
import { expect, test } from "@playwright/test";
import { control, eventually } from "@structure-ai/playwright/test";

test("an order placed through the UI converges into the list", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Item").fill("widget");
  await page.getByRole("button", { name: "Order" }).click();
  await eventually(async () => {
    await expect(page.getByRole("list")).toContainText("widget");
  });
});

test("business failures surface by tag", async () => {
  const attempt = control.dispatch("PlaceOrder", { sku: "gone" });
  await expect(attempt).rejects.toMatchObject({ tag: "OutOfStock" });
});
```

`bun run test:e2e` (i.e. `playwright test`) runs the suite; specs run under Playwright's Node runner while the app stays a Bun subprocess.

## Environment handoff

| Variable | Set by | Read by |
| --- | --- | --- |
| `STRUCTURE_TEST_CONTROL_PORT` | `defineE2eConfig` (backend env) | `TestControl.fromEnv()` |
| `STRUCTURE_TEST_CONTROL_TOKEN` | `defineE2eConfig` (backend env + worker env) | `TestControl.fromEnv()`, spec client |
| `STRUCTURE_TEST_CONTROL_URL` | `defineE2eConfig` (worker env) | spec client |

Playwright re-evaluates the config in every worker process; the factory reuses an already-present token instead of minting a fresh one, so all processes agree.

## Auth seeding

`control.auth.register({ email, password })` runs the real `AuthService`: password registration, verification e-mail captured by a recording sender, verification completed — returning `{ userId }`. Build the stack with `RecordingAuth.make({ tenantId, baseUrl })` (real service, in-memory store, recording sender) and pass it as the `auth` option. Specs sign in **through the real UI**; the control plane only seeds.

## Isolation

Playwright launches the webServers once per run, not per worker: the default isolation is unique data per test (uuids), plus an optional user-registered `reset` hook invoked via `control.reset()` in a test-scoped fixture. Per-worker app instances are a documented future enhancement.

## Exports

| Export | What it is |
| --- | --- |
| `TestControl.layer(options)` | The control-plane server layer (Bun side): dispatch/query/events/drain/reset/register behind a bearer token. |
| `TestControl.fromEnv()` | Reads `STRUCTURE_TEST_CONTROL_PORT`/`_TOKEN`, failing loudly when absent. |
| `RecordingAuth.make(options)` | Real `AuthService` over in-memory store + recording sender for e2e compositions. |
| `defineE2eConfig(options)` | Playwright config factory: webServers, readiness wait, token mint + handoff. |
| `control` / `makeControl` | Spec-side client: `dispatch`/`query`/`events`/`drain`/`reset`/`auth.register`. |
| `eventually(fn, options)` | Drain-and-poll until the assertion holds; `false` keeps polling, throws carry the last error. |
| `ControlFailure` | Spec-side rejection type carrying `tag` (+ HTTP `status` for transport failures). |

Dependencies (app side): `effect`, `@effect/platform`, `@effect/platform-bun`, `@structure-ai/cqrs` (buses), `@structure-ai/eventsourcing` (event store), `@structure-ai/auth` (seeding). Peer: `@playwright/test`. The spec side (`./test` subpath) is hand-written plain JS + `d.ts` — Node cannot execute the repo's TS-source exports, an exception to the no-build rule kept honest by ~200 dependency-free lines.

The fixture app under `test/` (todo aggregate, projection-backed list, vanilla frontend, specs) is the package's own executable example; its browser suite runs via `bun run test:e2e` (requires `bunx playwright install chromium` once), its `bun test` suite is network-free.
