---
name: override-auth-routes
description: Remap @structure-ai/auth HTTP endpoint paths through AuthHandlerOptions.routes - absolute paths, stable route ids, startup validation. Use when auth routes must move (framework conventions, collisions with existing app routes).
---

# Override auth routes

`makeAuthHandler` serves 17 fixed routes under `/auth` by default. The `routes` option remaps individual paths through **stable route ids** — it never wraps handlers, disables routes, or adds aliases. Renaming a path changes neither cookie paths nor the tenant-resolution/origin-check/error envelope. Reference: `packages/auth/README.md` → "HTTP routes".

## Steps

1. **Pick route ids** from the table in `packages/auth/README.md` (`signInPassword`, `getSession`, `oauthStart`, …). Ids mirror service methods where a 1:1 exists; they are contract-stable.

2. **Pass `routes` in `AuthHandlerOptions`** and run the constructor — it validates at construction and returns `Effect<AuthHandler, InvalidAuthRoutes>`:

```ts
import { makeAuthHandler } from "@structure-ai/auth";
import { Effect } from "effect";

const { handler } = await Effect.runPromise(
  makeAuthHandler(auth, {
    resolveTenant: (request) => resolveTenantFromHost(request),
    basePath: "/api/auth",
    routes: {
      signInPassword: "/login",
      oauthStart: "/login/oauth/:provider/start",
    },
  }),
);
```

3. **Update the coupled artifacts** — anything that references the moved path: frontend fetch calls, the application pages that receive emailed tokens and POST them back, and provider OAuth callback registrations (`oauthCallback`). The library does not alias old paths.

4. **Assert the move in tests**: the new path returns the old response (status + `set-cookie`) and the default path returns 404.

## Rules

- Override values are **absolute paths from root**; the overridden route leaves the `basePath` namespace. Non-overridden routes keep their `${basePath}/...` defaults.
- HTTP methods are fixed per route id — you remap paths only.
- `oauthStart`/`oauthCallback` overrides must contain exactly one `:provider` segment; every other route takes a literal path (no params, no query, no fragment, no trailing slash).
- Invalid shapes, unknown ids, and same-method collisions (a `:provider` segment matches any single segment, defaults included) fail at construction with **all** violations aggregated in `InvalidAuthRoutes` — never runtime shadowing. Fix every violation; there is no partial application.
- Route overrides are process-wide composition-time options, not runtime configuration and not per-tenant tables.

## Verify

`bun x tsc --noEmit && bun test` in `packages/auth`; exercise `packages/auth/test/routes.test.ts` for the validation matrix.
