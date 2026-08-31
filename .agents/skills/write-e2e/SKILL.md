---
name: write-e2e
description: Write and run browser E2E tests for a @structure-based app with @structure-ai/playwright - defineE2eConfig, TestControl entrypoint, spec client, eventually, auth seeding. Use when adding end-to-end UI tests or wiring an e2e entrypoint.
---

# Write browser E2E tests

`@structure-ai/playwright` tests the real application subprocess through the user's own frontend (`@playwright/test`), with a bearer-guarded test control plane for everything specs need beyond clicking: seeding, dispatch by tag, event reads, drain, auth users. `@structure-ai/bdd` stays the API-scenario layer — do not duplicate a bdd scenario as a UI spec unless the browser is the point.

Reference: `packages/playwright/` — sources and the fixture app (`test/fixture` + `test/e2e`) are the executable example.

## Steps

1. **Config** — `playwright.config.ts` at the app package root:

```ts
import { defineConfig } from "@playwright/test";
import { defineE2eConfig } from "@structure-ai/playwright/test";

export default defineConfig({
  testDir: "test/e2e",
  ...defineE2eConfig({
    backend: { command: "bun src/e2e-main.ts", url: "http://127.0.0.1:3000/health/ready" },
    frontend: { command: "bun run frontend dev", url: "http://127.0.0.1:5173" },
  }),
});
```

   The factory mints the control token, injects `STRUCTURE_TEST_CONTROL_PORT`/`_TOKEN` into the backend env, and exports `_URL`/`_TOKEN` to spec workers. `backend.url` should be the app's readiness probe — the framework's `/health/ready` means migrations and resources are done.

2. **Test entrypoint** — `src/e2e-main.ts` mirroring `src/main.ts` plus the control plane. `TestControl.fromEnv()` reads the injected settings (missing token = loud startup failure); compose `TestControl.layer({ port, token, commands, queries, drain, auth })` with the app composition, next to `serve()`. Never import it from the production entrypoint — the control server exists only where composed.

3. **Specs** — plain promises, never Effect:

```ts
import { control, eventually } from "@structure-ai/playwright/test";

const { orderId } = await control.dispatch<{ orderId: string }>("PlaceOrder", { sku: "sku-1" }, { actor: "agent" });
await eventually(async () => {
  await expect(page.getByRole("list")).toContainText("sku-1");
});
```

   Dispatch accepts registry keys or message tags; business failures reject with `ControlFailure` carrying the tag (`rejects.toMatchObject({ tag: "OutOfStock" })`). Unknown names fail loudly with the registered list.

4. **Eventual consistency** — never `sleep`. `eventually(fn)` drains the server (outbox relay, projection catch-up — whatever the app registered as `drain`) and polls; `fn` may return `false` to keep polling; the timeout error carries the last failure. Register the same drain hook the bdd suite uses.

5. **Auth** — seed with `control.auth.register({ email, password })` (needs the `auth` option: `RecordingAuth.make(...)` in the entrypoint — real `AuthService`, recording sender, verification completed automatically). Sign in through the real UI; the control plane only seeds.

6. **Isolation** — one shared app per run: unique data per test (uuids), and/or a user-registered `reset` hook called from a test-scoped fixture via `control.reset()`. Per-worker app instances are not in v1.

7. **Run** — `bun run test:e2e` (`playwright test`). Browsers once: `bunx playwright install chromium`. CI: a dedicated job (see `.github/workflows/ci.yml` `e2e`); the package's plain `bun test` stays network-free.

## Rules

- Spec files import only `@playwright/test` and `@structure-ai/playwright/test` — plain JS at runtime; never Effect.
- The control plane is composition-scoped and token-guarded; never enable it in production composition, never log the token.
- `control.dispatch` runs through the bus: validation, authorization (pass `actor`), idempotency, metrics all apply — it is a real dispatch, not a database write.
- Do not widen the control api ad hoc; a missing capability (e.g. view-model reads) goes through a query registered in `queries`, not a new endpoint.

## Verify

`bun run test:e2e` in the app package; `bun x tsc --noEmit && bun test` for the package's own suites.
