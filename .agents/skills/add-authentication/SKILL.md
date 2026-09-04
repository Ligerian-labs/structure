---
name: add-authentication
description: Add tenant-aware authentication to a @structure-based app - passwords, magic links, sessions, passkeys, OAuth, HTTP routes, durable store. Use when users or tenants need to sign in.
---

# Add authentication

`@structure-ai/auth` provides the password lifecycle, magic links, opaque sessions, passkeys, OAuth 2/OIDC, and a Web `Request` handler — with application-owned ports for storage, delivery, rate limits, and audit. Authentication is the boundary: profiles, roles, and resource authorization stay in their owning contexts (authorization is `@structure-ai/authorization`). Reference: `packages/auth/README.md`.

## Steps

1. **Compose the service** with your ports:

```ts
import { allowAllRateLimiter, inMemoryAuthStore, makeAuth } from "@structure-ai/auth";

const auth = makeAuth({
  store: store,                          // AuthStore port (see step 3)
  resolveTenant: (tenantId) => Effect.succeed({
    baseUrl,
    links: {
      emailVerification: "/verify-email",
      magicLink: "/sign-in/link",
      passwordReset: "/reset-password",
    },
    passkey: { rpId, rpName, origins },
    oauth: { google: { clientId, clientSecret } },
  }),
  emailSender: { send: (message) => sendWithApplicationMailer(message) },
  rateLimiter: applicationRateLimiter,   // NOT allowAllRateLimiter in production
  audit: applicationAuditSink,
});
```

2. **Expose the routes**: `makeAuthHandler(auth, { resolveTenant })` returns `Effect<AuthHandler, InvalidAuthRoutes>` — run it with `Effect.runPromise` or compose it in your startup `Effect.gen`. Defaults to `/auth`, tenant resolved from trusted host/routing data (never a JSON body field), origins checked on mutations, `Cache-Control: no-store`. Set `oauthCallbackRedirect` when browser callbacks should return 303 instead of JSON. Register the URI returned by `authorizationServerRedirectUri(tenantId, provider)` with each provider. Token pages configured through `TenantAuthConfig.links` POST the token so link scanners don't consume credentials. Remap individual paths with `routes` (stable route ids) — see the `override-auth-routes` skill.
3. **Pick the store**:
   - `inMemoryAuthStore()` — tests and local dev only.
   - `@structure-ai/auth-sqlite` / `auth-pg` — durable: schema first, in the designated migration process only (`auth-pg`: `migration(id[, { tablePrefix }])` in the app's `@structure-ai/migrations` set, or `migrate(sql[, options])` over Bun `SQL`; `auth-sqlite`: `migrate(sql[, options])`), then `makeAuthStore(sql[, options])` — stores never migrate.
   - Custom `AuthStore` — preserve the compound-transaction semantics (atomic one-time consumption, password change + session revocation in one transaction, tenant-scoped uniqueness).
4. **Sessions**: opaque 256-bit bearer token returned as `Redacted`; only SHA-256 digests are stored. Turn it into a `Principal` for `@structure-ai/authorization` at your app's edge (session lookup → `Principal.within`).
5. **Account linking** is deny-by-default (`AccountLinkDenied`); supply an `AccountLinkPolicy.authorize` only with an explicit product decision.
6. **Tests:** follow `packages/auth/test/` (password, magic-link, OAuth, passkey, rate-limit/audit, HTTP) and `packages/auth-sqlite/test/` for the durable path.

## Rules

- Production must provide a durable/shared rate limiter; `allowAllRateLimiter` is for tests and prototypes only.
- HTTP walls in front of the auth routes use `@structure-ai/http`'s `rateLimitLayer`: key the login group with `keys` (ip via `clientIp(request, { trustProxy })` + email digest) and `consumeWhen: (response) => response.status === 401`, so a successful login costs nothing and ten POSTs naming a victim's address cannot lock that account (see the http README, "Rate limiting"). `trustProxy` is a setting, `true` only behind a proxy you operate.
- Raw one-time/session tokens and OAuth client secrets never enter storage, logs, audit events, or errors — they are `Redacted` at the boundary.
- Enumeration-safe responses: password-reset and magic-link requests give no account-existence signal.
- A successful password reset or change revokes every older session.
- Expired token/session/challenge cleanup is the application's scheduled job, not the library's.

## Verify

`bun x tsc --noEmit && bun test` in the package (pg-gated tests skip unless `DATABASE_URL` is set).
