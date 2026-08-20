# @structure-ai/auth

Tenant-aware authentication for Bun/Effect applications without an external auth or cryptography dependency. It provides the complete password lifecycle, email magic links, opaque sessions, passkeys, OAuth 2/OIDC providers, a Web `Request` handler, and application-owned ports for storage, delivery, rate limits, audit, policy, and provider extensions.

Authentication is the boundary here. Application profiles, permissions, roles, and resource authorization remain in their owning bounded contexts.

## Quick start

```ts
import {
  allowAllRateLimiter,
  inMemoryAuthStore,
  makeAuth,
  makeAuthHandler,
} from "@structure-ai/auth";
import { Effect, Redacted } from "effect";

const memory = inMemoryAuthStore(); // development/tests only

const auth = makeAuth({
  store: memory.store,
  resolveTenant: (tenantId) =>
    Effect.succeed({
      baseUrl: new URL(`https://${tenantId}.example.com`),
      passkey: {
        rpId: `${tenantId}.example.com`,
        rpName: "Example",
        origins: [`https://${tenantId}.example.com`],
      },
      oauth: {
        google: {
          clientId: "google-client-id",
          clientSecret: Redacted.make("loaded-from-secret-config"),
        },
      },
    }),
  emailSender: {
    send: (message) => sendWithApplicationMailer(message),
  },
  rateLimiter: applicationRateLimiter,
  audit: applicationAuditSink,
});

const { handler } = makeAuthHandler(auth, {
  // Resolve tenant from trusted host/routing data, never a JSON body field.
  resolveTenant: (request) => resolveTenantFromHost(request),
});
```

`allowAllRateLimiter` is exported for tests and local prototypes. Production composition must provide a durable/shared limiter appropriate to its topology.

## Capabilities

| Capability | Contract |
| --- | --- |
| Password | Registration, mandatory email verification, sign-in/out, change, forgotten-password reset, and all-session revocation. Bun `password` performs Argon2id off the main thread (defaults: 64 MiB, 3 iterations). |
| Magic link | Enumeration-safe request response, expiring single-use token, verified account provisioning, opaque session creation. |
| Sessions | 256-bit opaque bearer token returned as `Redacted`; only SHA-256 digests enter storage. Expiry, individual revocation, all-user revocation, and secure cookie helpers. |
| Passkey | Registration/authentication ceremonies; strict challenge, type, origin, RP ID hash, user-presence/user-verification, signature, and counter validation. Supports ES256, RS256, and Ed25519. |
| OAuth | Authorization code + S256 PKCE + single-use state. Built-in Google, GitHub, X, and LinkedIn definitions; injected bounded HTTP client and provider resolver. |
| Multi-tenancy | Tenant ID scopes users, emails, identities, tokens, sessions, challenges, passkeys, and provider configuration. |
| Extension policy | Custom `AuthStore`, `EmailSender`, `RateLimiter`, `AuthAuditSink`, `AccountLinkPolicy`, `OAuthHttpClient`, `OAuthProviderResolver`, password hasher, clock/random/token primitives, and HTTP origin policy. |

## Core workflows

Every method returns an `Effect` with classified tagged errors. Tokens and session cookies are `Redacted` at the API boundary.

```ts
const program = Effect.gen(function* () {
  const pending = yield* auth.registerPassword({
    tenantId: "acme",
    email: "ada@example.com",
    password: "a long application-approved password",
  });

  // Token arrives through EmailSender, then the client submits it.
  const verified = yield* auth.verifyEmail("acme", verificationToken);
  const session = yield* auth.signInPassword(
    "acme",
    "ada@example.com",
    "a long application-approved password",
  );

  const registration = yield* auth.beginPasskeyRegistration("acme", session.token);
  // navigator.credentials.create({ publicKey: registration }) in the browser
  yield* auth.finishPasskeyRegistration("acme", session.token, browserResponse);

  const oauth = yield* auth.beginOAuth("acme", "github", "/settings");
  // Redirect to oauth.authorizationUrl. The callback submits state + code.

  return { pending, verified };
});
```

Password reset and magic-link request methods deliberately return no account-existence signal. A successful password reset or change revokes every older session and returns a fresh one.

## HTTP routes

`makeAuthHandler` defaults to `/auth`, accepts JSON bodies up to 64 KiB, checks mutation origins, resolves the tenant through the caller, maps errors without internal causes, and sets `Cache-Control: no-store`.

| Method | Path |
| --- | --- |
| POST | `/auth/register/password` |
| POST | `/auth/verify-email` |
| POST | `/auth/email-verification/request` |
| POST | `/auth/sign-in/password` |
| POST | `/auth/sign-out` |
| GET | `/auth/session` |
| POST | `/auth/password/reset/request` |
| POST | `/auth/password/reset/complete` |
| POST | `/auth/password/change` |
| POST | `/auth/magic-link/request` |
| POST | `/auth/magic-link/consume` |
| POST | `/auth/oauth/:provider/start` |
| GET | `/auth/oauth/:provider/callback` |
| POST | `/auth/passkeys/register/options` |
| POST | `/auth/passkeys/register/verify` |
| POST | `/auth/passkeys/authenticate/options` |
| POST | `/auth/passkeys/authenticate/verify` |

Magic-link/reset/verification emails land on application pages. Those pages POST the token to the matching endpoint so link scanners do not consume credentials merely by fetching a URL.

## Persistence contract

`AuthStore` is application-owned. Its compound mutation methods are intentional transaction boundaries:

- `createPasswordUser` and `createOAuthUser` atomically enforce tenant-scoped user/email/identity uniqueness.
- `consumeOneTimeToken`, `consumeOAuthState`, and `consumePasskeyChallenge` atomically remove a value before returning it, including when expired.
- `replacePasswordAndRevokeSessions` changes the hash and removes all sessions in one transaction.
- `addOAuthIdentity` and `addPasskey` enforce tenant-scoped credential uniqueness.
- counters may only be updated after successful signature verification.

A durable adapter must preserve those semantics and may fail with `AuthStoreError`; it must never store raw one-time/session tokens or OAuth client secrets. `inMemoryAuthStore` is deterministic enough for local development and tests, but is neither durable nor a cross-instance rate limiter.

## Account linking

The default `denyAccountLinking` never joins accounts by email. A new provider identity matching an existing verified email fails with `AccountLinkDenied`. An application that wants linking supplies `AccountLinkPolicy.authorize`; the request includes the tenant, provider subject, verified provider profile, target user, and authenticated requesting user when present.

OAuth profiles without email are supported (notably X). Unverified provider email does not claim the tenant's email uniqueness key.

## Passkey limits

- Registration accepts `none` attestation and packed **self-attestation**. Certificate-backed/basic/enterprise attestation and every other format fail closed.
- COSE algorithms are limited to ES256, RS256, and Ed25519. The parser rejects indefinite CBOR, unsafe lengths, excessive nesting, malformed keys, and mismatched algorithms.
- User verification is required by default. Applications may explicitly make it preferred per tenant.
- Zero-only counters are accepted for authenticators without counters; a positive stored counter must increase.
- RP IDs and exact allowed origins are tenant configuration, never client input.

## Security and operations

- `baseUrl` must use HTTPS except `http://localhost`/`127.0.0.1` for development.
- OAuth secrets, access tokens, codes, session tokens, and email tokens are `Redacted` and excluded from audit events and errors.
- Rate-limiter keys are SHA-256 digests; email addresses and tokens are not sent to the limiter.
- `AuthAuditSink` receives successful security state transitions with stable action/user/provider fields only and must absorb its own delivery failures. Record rejected requests at the owning edge if required by application policy.
- Provider calls default to a 10-second timeout and reject non-success, malformed, or responses larger than 1 MiB. No retries occur inside auth.
- OAuth endpoints and provider response contracts can change. Keep provider conformance tests and review upstream changes before deployment.
- Session and token cleanup, credential retention/deletion, backup/restore, encryption at rest, mail reputation, and rate-limit capacity are responsibilities of the durable application adapter and its runbooks.

## Exports

| Export group | Purpose |
| --- | --- |
| `makeAuth`, `AuthService`, `MakeAuthOptions` | Main Effect workflow service. |
| `makeAuthHandler`, `AuthHandlerOptions` | Web-standard transport adapter. |
| `AuthStore`, `inMemoryAuthStore` | Persistence port and development/test adapter. |
| `argon2id`, `PasswordHasher` | Bun Argon2id implementation and replacement port. |
| `OAuthProvider*`, `builtInOAuthProvider`, `fetchOAuthHttpClient` | Provider definitions, tenant resolver, exchange/profile engine, HTTP port. |
| `verifyPasskeyRegistration`, `verifyPasskeyAuthentication` | Strict WebAuthn/COSE verification used by the service. |
| `RateLimiter`, `AuthAuditSink`, `AccountLinkPolicy`, `EmailSender` | Application policy and side-effect ports. |
| `Auth*Error`, `RateLimitExceeded`, `UnsupportedPasskey` | Classified safe failures. |

See `test/` for executable password, magic-link, OAuth, passkey, rate-limit/audit, and HTTP examples.
