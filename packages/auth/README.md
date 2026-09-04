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

const { handler } = await Effect.runPromise(
  makeAuthHandler(auth, {
    // Resolve tenant from trusted host/routing data, never a JSON body field.
    resolveTenant: (request) => resolveTenantFromHost(request),
    // The caller's subject for the anonymous walls: the client address as
    // your trusted proxy reports it (never a header the client can set).
    callerSubject: (request) => clientAddressBehindProxy(request),
  }),
);
```

`allowAllRateLimiter` is exported for tests and local prototypes. Production composition must provide a durable/shared limiter appropriate to its topology.

### Rate-limit walls: what they key on

Every wall keys on a SHA-256 digest of its subject. Walls in front of a *target* key on that target (an email, a token, a session, a credential id). Walls in front of an *anonymous* entry point key on the **caller** (`AuthCaller`, `{ subject }`: the client address behind the trusted proxy, or any per-request subject the app derives), never on a constant shared by everyone:

| Action | Key |
| --- | --- |
| `password-sign-in` | two buckets when a caller is given: the email joined with the caller's subject (a stranger cannot spend an account's budget from elsewhere) AND the caller's subject alone (a ceiling on spraying many emails from one place); the email alone otherwise |
| `passkey-authenticate` (challenge) | the email when given, else the caller's subject; with neither, **no wall** |
| `passkey-authenticate` (verify) | the caller's subject when given, else the credential id |
| `oauth-start` | the caller's subject; without one, **no wall** |

The service methods take the caller as a trailing optional argument (`signInPassword(tenantId, email, password, caller?)`, `beginOAuth(tenantId, provider, returnTo?, caller?)`, `beginPasskeyAuthentication(tenantId, email?, caller?)`, `finishPasskeyAuthentication(tenantId, response, caller?)`); `makeAuthHandler` derives it through `callerSubject`. Without a caller subject the two anonymous walls do not apply at all (a shared constant key would let one caller exhaust everyone's budget): put your own per-address wall in front of those routes in that case.

**Consume on failure.** A `RateLimiter` may implement `peek` beside `check`. When it does, the password sign-in wall peeks before verifying and charges (`check`) only a rejected sign-in (a wrong password, an unknown account, an unverified email alike), so naming a victim's email costs the caller their own budget and never the victim's sign-in. Without `peek` the wall charges on arrival, as before. The framework's caller bucket is a ceiling per caller subject; a per-address wall in front of the route (`@structure-ai/http`'s rate limiter) remains the place to bound raw request volume.

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

`makeAuthHandler` validates its route table at construction and returns `Effect<AuthHandler, InvalidAuthRoutes>`. It accepts JSON bodies up to 64 KiB, checks mutation origins, resolves the tenant through the caller, maps errors without internal causes, and sets `Cache-Control: no-store`. Routes default to the `/auth` namespace (`basePath` moves it).

| Route id | Method | Default path |
| --- | --- | --- |
| `registerPassword` | POST | `/auth/register/password` |
| `verifyEmail` | POST | `/auth/verify-email` |
| `requestEmailVerification` | POST | `/auth/email-verification/request` |
| `signInPassword` | POST | `/auth/sign-in/password` |
| `signOut` | POST | `/auth/sign-out` |
| `getSession` | GET | `/auth/session` |
| `requestPasswordReset` | POST | `/auth/password/reset/request` |
| `resetPassword` | POST | `/auth/password/reset/complete` |
| `changePassword` | POST | `/auth/password/change` |
| `requestMagicLink` | POST | `/auth/magic-link/request` |
| `consumeMagicLink` | POST | `/auth/magic-link/consume` |
| `oauthStart` | POST | `/auth/oauth/:provider/start` |
| `oauthCallback` | GET | `/auth/oauth/:provider/callback` |
| `passkeyRegisterOptions` | POST | `/auth/passkeys/register/options` |
| `passkeyRegisterVerify` | POST | `/auth/passkeys/register/verify` |
| `passkeyAuthenticateOptions` | POST | `/auth/passkeys/authenticate/options` |
| `passkeyAuthenticateVerify` | POST | `/auth/passkeys/authenticate/verify` |

### Route overrides

`routes` remaps individual paths through stable route ids. Values are absolute paths: an overridden route is served at exactly that path (its HTTP method unchanged) and leaves the base namespace; every other route keeps its default. `oauthStart` and `oauthCallback` overrides must contain exactly one `:provider` segment; all other routes accept literal paths only.

```ts
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

Invalid shapes, unknown ids, and same-method path collisions (a `:provider` segment matches any single segment, including defaults) fail construction with every violation aggregated in `InvalidAuthRoutes` — overrides never shadow each other silently at runtime. Renaming paths changes neither cookie paths nor the origin/tenant/error envelope. Route ids are contract-stable; renaming an id is a breaking change.

Magic-link/reset/verification emails land on application pages. Those pages POST the token to the matching endpoint so link scanners do not consume credentials merely by fetching a URL.

## API keys

Machine credentials for CLIs, CI jobs, and agents: `sk_<keyId>_<pepperVersion>_<secret>` keys with bounded power.

```ts
import { inMemoryApiKeyStore, makeApiKeys } from "@structure-ai/auth";
import { Effect, Redacted } from "effect";

const apiKeys = makeApiKeys({
  store: inMemoryApiKeyStore(), // or makeApiKeyStore from auth-sqlite / auth-pg
  peppers: {
    current: { version: 2, pepper: Redacted.make(process.env.AUTH_APIKEY_PEPPER_V2) },
    retired: [{ version: 1, pepper: Redacted.make(process.env.AUTH_APIKEY_PEPPER_V1) }],
  },
  // The owning user must still stand (exists / live membership): dead users
  // answer 401 before any workspace or scope answer.
  resolveUser: (tenantId, userId) => userStillStands(tenantId, userId),
});

const minted = yield* apiKeys.mint("tenant-a", {
  userId: "user-1",
  name: "ci-deploy",
  scopes: ["data:export"],     // the only powers this key holds
  workspaceId: "ws-1",         // optional per-key pinning
  expiresAt: new Date("2027-01-01"),
});
// Show Redacted.value(minted.key) once; only its HMAC-SHA256 hash is stored.

const standing = yield* apiKeys.verify("tenant-a", bearerToken);
// standing.principal: { id, kind: "service", roles: ["machine"], attributes: { scopes, workspaceId } }
// Feed it to @structure-ai/authorization: define a "machine" role granting
// only scope-conditioned permissions — unlisted routes fail closed, human
// principals keep theirs. Workspace mismatch (request workspace !=
// standing.workspaceId) is the app's 403; dead credentials already answered 401.
```

Semantics:

- **Hashed at rest**: `HMAC-SHA256(pepper, secret)`; secrets are 32 random bytes (hex, so the key format can never split).
- **Pepper versioning**: keys minted under older peppers keep verifying while those peppers stay listed in `retired`; the first successful use rehashes the key under the current pepper (lazy rotation). A pepper removed from the set rejects its remaining keys.
- **Constant-time** comparisons; garbage keys fail shape checks without a store lookup.
- **Expiry and last-use tracking** on every record; revocation is immediate.
- Storage: `ApiKeyStore` port with an in-memory adapter here and `makeApiKeyStore` in `@structure-ai/auth-sqlite` / `@structure-ai/auth-pg` (tenant-scoped, hash-rotation aware).

## TOTP two-factor

RFC 6238 second factor with lockout, recovery codes, and session elevation:

```ts
import { makeAuth, makeTotp } from "@structure-ai/auth";
import { Effect } from "effect";

// Sessions of enrolled users are born 2fa-pending:
const auth = makeAuth({
  /* ... */
  secondFactor: {
    isEnrolled: (tenantId, userId) =>
      totp.isEnrolled(tenantId, userId).pipe(Effect.catchAll(() => Effect.succeed(false))),
  },
});

const totp = makeTotp({
  store,               // the same AuthStore: TOTP lives in its contract
  auth,
  resolveTenant,
  rateLimiter,
  secret: instanceSecret,       // Redacted; seals the second factor at rest (see below)
  lockoutThreshold: 5,          // failed attempts before lockout
  lockoutCooldownMillis: 15 * 60_000,
  audit: auditSink,
});

// Enrollment: show the QR payload once, confirm with a first valid code.
const { secretBase32, otpauthUrl } = yield* totp.beginEnrollment("tenant-a", sessionToken);
const { recoveryCodes } = yield* totp.confirmEnrollment("tenant-a", sessionToken, code);

// Verification elevates the session; codes may be TOTP or recovery codes.
yield* totp.verify("tenant-a", sessionToken, code);               // { elevated: true }
const pending = yield* totp.sessionRequiresElevation("tenant-a", sessionToken);
// Guard sensitive routes on that flag (or a @structure-ai/authorization
// condition reading it). Unenroll with a TOTP code or a recovery code:
yield* totp.unenroll("tenant-a", sessionToken, codeOrRecoveryCode);
// Operator break-glass (lost authenticator AND lost recovery codes), audited:
yield* totp.resetSecondFactor("tenant-a", userId, { actor: "ops@example.com" });
```

Semantics:

- **Secrets**: 20 random bytes, base32; codes are 6 digits, step 30s, accepted within ±1 step with constant-time comparison (fixed candidate order — timing never discloses which step matched).
- **One-time codes** (RFC 6238 §5.2): the time step of an accepted code is remembered (`TotpRecord.lastUsedStep`, claimed atomically through `markTotpStepUsed`), so the same code never elevates twice — not on another session, not on `unenroll`, and the code that confirmed the enrollment is spent too. A replay counts as a failed attempt.
- **Recovery codes**: 10 single-use `xxxxx-xxxxx` codes, returned once as `Redacted`; each elevates a session or unenrolls the factor exactly once (consumed by compare-and-delete). A recovery code is what lets the owner of a lost authenticator turn the factor off and re-enroll.
- **Operator reset**: `resetSecondFactor(tenantId, userId, { actor })` removes an enrollment without any code, for the member who lost both the authenticator and the codes. It is audited as `totp-reset` with the operator as `actor`; expose it only behind the application's operator surface (a CLI, a superadmin route), never to the user.
- **At rest** (`secret`, at least 32 characters, checked when `makeTotp` is built so a misconfiguration fails at boot): the TOTP secret is stored encrypted (AES-256-GCM) and recovery codes as salted keyed hashes (HMAC-SHA-256, a fresh salt per code), both under keys derived from `secret` with HKDF-SHA-256 and a purpose label, so a database read (a backup, a replica, an export) yields no second factor and no precomputed table transfers between users or instances. Stored values carry a `v1:` prefix; enrollments written before sealing existed keep verifying and are sealed on their next successful verification. Rotating `secret` invalidates every enrollment sealed under the old one: rotate it as an announced re-enrollment, not silently.
- **Lockout**: failed attempts count per principal; at the threshold the second factor locks for the cooldown (`RateLimitExceeded` with `Retry-After`), audited as `totp-locked`. A locked factor never bypasses — verification keeps failing until the cooldown passes or the enrollment is removed through the owner flow or the operator reset.
- **Session elevation**: `SessionRecord.elevatedAt` is absent while a confirmed enrollment keeps a session `2fa-pending`; `totp.verify` sets it.
- **Storage**: through the existing `AuthStore` contract (`putTotpSecret`, `confirmTotp`, `markTotpStepUsed`, `replaceTotpSecret`, `recordTotpFailure`, `consumeRecoveryCode`, `elevateSession`, ...) — in-memory here, durable in `auth-sqlite` / `auth-pg` (same scenarios). The store only ever sees sealed material.

## Generic external OIDC login (gated JIT provisioning)

Enterprises point at their own IdP (Azure AD, Okta, Keycloak) through OIDC discovery; the profile comes from a **JWKS-validated ID token** (RS256/ES256 via WebCrypto, `iss`/`aud`/`exp` checked) — no userinfo roundtrip, no raw provider tokens downstream:

```ts
import { discoverOidc, makeAuth, oidcProvisioningPolicy, oidcSettings } from "@structure-ai/auth";
import { Effect, Redacted } from "effect";

// Settings (secrets Redacted, JIT default OFF):
//   OIDC_ISSUER_URL, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET,
//   OIDC_JIT_PROVISIONING (default false), OIDC_JIT_DEFAULT_TENANT, OIDC_LABEL
const settings = yield* load(oidcSettings);

const { provider } = yield* discoverOidc(
  {
    issuer: settings.issuer,
    credentials: { clientId: settings.clientId, clientSecret: settings.clientSecret },
  },
  httpClient,
);

const auth = makeAuth({
  /* ... */
  oauthHttpClient: httpClient,
  oauthProviderResolver: {
    resolve: (tenantId, providerId) =>
      Effect.succeed(providerId === "oidc" ? provider : undefined),
  },
  // Unknown identities only become accounts when JIT is deliberately on —
  // and only inside the configured default tenant.
  identityProvisioning: oidcProvisioningPolicy(settings),
});
```

Semantics:

- **Discovery** at `<issuer>/.well-known/openid-configuration`; the JWKS is cached and refetched once on an unknown `kid`.
- **JIT off (default)**: only already-linked identities sign in; unknown ones are indistinguishable from wrong credentials (no account enumeration). **JIT on**: provisioning lands in `OIDC_JIT_DEFAULT_TENANT` only.
- **Linking**: one local identity ↔ one external subject; automatic linking by verified email stays behind the app's `AccountLinkPolicy`; `unlinkOAuthIdentity` is the explicit owner action (audited as `oauth-unlink`).
- Works alongside the fixed social providers and password/magic-link flows (`providerId` `"oidc"` by default).

## OAuth 2.1 authorization server (provider side)

Act **as** the OAuth server so agent clients (Claude Code, connectors, CLIs) obtain scoped tokens against your instance's own API:

```ts
import {
  generateSigningKey,
  makeAuthorizationServer,
  inMemoryOAuthServerStore, // or makeOAuthServerStore from auth-sqlite / auth-pg
} from "@structure-ai/auth";
import { Effect } from "effect";

const key = yield* generateSigningKey(); // RS256; rotate by moving current → previous

const as = makeAuthorizationServer({
  store: inMemoryOAuthServerStore(),
  resolveTenant: (tenantId) => Effect.succeed({ baseUrl }),
  signingKeys: { current: key },
  // Registration gates — env switches, never code removal. BOTH CLOSED by default.
  registration: { anonymous: false, signedIn: false },
});

// RFC 7591-style registration (only while a gate is open):
const client = yield* as.registerClient("tenant-a", {
  clientType: "confidential", // secret hashed at rest, shown once
  redirectUris: ["https://agent.example.com/callback"],
  scopes: ["mcp:tools", "data:export"],
}, { kind: "signed-in", userId: "user-1" });

// Authorization code + PKCE (S256 only; plain refused):
const decision = yield* as.authorize({ /* clientId, redirectUri, scope, codeChallenge */ }, userId);
// → { consentRequired } until grantConsent, then { redirectUrl } with a 60s single-use code.
const tokens = yield* as.exchangeCode({ /* clientId, clientSecret?, code, codeVerifier, redirectUri */ });
// → JWT access token (RS256, kid-headered) + rotating refresh token.

// Refresh / revoke / introspect / JWKS:
yield* as.refresh({ ... });     // rotation: the old refresh token dies on use
yield* as.revoke({ ... });      // RFC 7009: idempotent, unknown tokens still succeed
yield* as.introspect({ ... });  // active + scope/client/user/expiry
as.jwks();                      // current + previous public keys

// Resource side: signature first, then claims, then the record.
const claims = yield* as.verifyAccessToken("tenant-a", bearer); // InvalidAuthToken on any doubt
```

Hardening, carried from the template's incident history:

- **`authorize` validates params before anything else**; unknown client or unregistered `redirect_uri` fails closed — never a redirect.
- **Registration gates are options**, never code removal; both default closed.
- **Signature before claims**: `verifyAccessToken` selects the key by the header's `kid`, refuses any `alg` but `RS256` (`none` included), verifies the RSASSA-PKCS1-v1_5 signature over the header and payload, and only then reads the claims and consults the token record. A rewritten payload, a missing or garbage signature, or a payload re-signed under a foreign key is `InvalidAuthToken`. (`OAuthSigningKey.publicKey` is optional: a key restored from storage as private key + JWK gets its verifying half imported from `publicJwk` on first use.)
- **Scope-restricted tokens**: `verifyAccessToken` returns `{ sub, aud, scope, tid }`; compose it into a `@structure-ai/authorization` machine principal (scope-conditioned role) — unlisted routes fail closed for machine principals.
- **Refresh-token families**: the tokens of one grant share a `familyId` set at code exchange and carried through every rotation. Presenting a rotated-away refresh token (the one signal the protocol gives that it leaked) revokes the whole family, access and refresh tokens alike, whoever holds the descendants, and is reported to the optional `audit` sink as `oauth-refresh-reuse`, once per family: replaying a token whose family is already dead revokes nothing and raises nothing more. Only rotation arms that detector (`rotatedAt`): a refresh token the client revoked through the revocation endpoint, or that died with its family, is simply refused when presented again, with no collateral and no alarm. Rotation itself is a conditional write (`rotateToken` lands on a live token only), so two concurrent presenters of one refresh token can never both rotate it: the loser is treated as reuse, family revoked, audited. That is the strict reading of OAuth 2.1 §4.3.1; a client that refreshes the same token from two places at once is signed out and must re-authorize. The winner is never handed a pair the loser's sweep has already killed: after rotating, `refresh` re-reads its fresh refresh token and refuses when it is no longer live, so both presenters see the refusal (`invalid_grant`) rather than one of them a token that fails on first use. Operations note: because the pair is minted before the rotation, a refused concurrent refresh of a live token leaves the pair it minted behind, revoked, expiring with the refresh-token TTL (two rows per refused presentation; replays of an already dead token mint nothing). The application's expired-row cleanup removes them, like every other expired token; the cost is bounded per stolen token, since its first race kills the family. Records minted before families existed root a family under their own id when next refreshed.
- **JWKS rotation invalidates nothing**: the previous key keeps verifying (and revocation is still honored) until it is dropped.
- **No route ever hands a caller a provider grant** — this server only ever issues *its own* tokens.
- **End-session** acts only for its caller: single-use hints with a bounded grace (default 5 minutes), consumed atomically.

Storage: `OAuthServerStore` port (clients, single-use codes, consents, tokens with `revokeFamily`, end-session hints) with an in-memory adapter here and `makeOAuthServerStore` in `auth-sqlite` / `auth-pg`.

## Persistence contract

`AuthStore` is application-owned. Its compound mutation methods are intentional transaction boundaries:

- `createPasswordUser` and `createOAuthUser` atomically enforce tenant-scoped user/email/identity uniqueness.
- `consumeOneTimeToken`, `consumeOAuthState`, and `consumePasskeyChallenge` atomically remove a value before returning it, including when expired.
- `replacePasswordAndRevokeSessions` changes the hash and removes all sessions in one transaction.
- `addOAuthIdentity` and `addPasskey` enforce tenant-scoped credential uniqueness.
- counters may only be updated after successful signature verification.
- `markTotpStepUsed` claims a TOTP time step atomically (false when that step or a later one was already accepted); `consumeRecoveryCode` removes exactly the presented entry by compare-and-delete; `replaceTotpSecret` rewrites only the stored secret.
- `OAuthServerStore.revokeFamily` revokes every live token carrying a family id.

A durable adapter must preserve those semantics and may fail with `AuthStoreError`; it must never store raw one-time/session tokens or OAuth client secrets. `@structure-ai/auth-sqlite` and `@structure-ai/auth-pg` provide Bun-native implementations with explicit schema migration functions. `inMemoryAuthStore` is deterministic enough for local development and tests, but is neither durable nor a cross-instance rate limiter.

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
- Rate-limiter keys are SHA-256 digests; email addresses, caller subjects, and tokens are not sent to the limiter. Anonymous walls key on the caller the app names (`callerSubject`), never on a shared constant.
- Second-factor material is sealed at rest under the instance secret; access tokens are verified by signature before any claim is trusted; refresh-token reuse revokes the family.
- `AuthAuditSink` receives successful security state transitions with stable action/user/provider fields only and must absorb its own delivery failures. Record rejected requests at the owning edge if required by application policy.
- Provider calls default to a 10-second timeout and reject non-success, malformed, or responses larger than 1 MiB. No retries occur inside auth.
- OAuth endpoints and provider response contracts can change. Keep provider conformance tests and review upstream changes before deployment.
- Session and token cleanup, credential retention/deletion, backup/restore, encryption at rest, mail reputation, and rate-limit capacity are responsibilities of the durable application adapter and its runbooks.

## Exports

| Export group | Purpose |
| --- | --- |
| `makeAuth`, `AuthService`, `MakeAuthOptions` | Main Effect workflow service. |
| `makeAuthHandler`, `AuthHandlerOptions`, `AuthRouteId`, `AuthRouteViolation` | Web-standard transport adapter with configurable route paths. |
| `AuthStore`, `inMemoryAuthStore` | Persistence port and development/test adapter. |
| `argon2id`, `PasswordHasher` | Bun Argon2id implementation and replacement port. |
| `OAuthProvider*`, `builtInOAuthProvider`, `fetchOAuthHttpClient` | Provider definitions, tenant resolver, exchange/profile engine, HTTP port. |
| `discoverOidc`, `validateIdToken`, `oidcSettings`, `oidcProvisioningPolicy` | Generic OIDC: discovery + JWKS-validated ID tokens, JIT-gated provisioning settings. |
| `verifyPasskeyRegistration`, `verifyPasskeyAuthentication` | Strict WebAuthn/COSE verification used by the service. |
| `RateLimiter` (`check` + optional `peek`), `AuthCaller`, `AuthAuditSink`, `AccountLinkPolicy`, `EmailSender` | Application policy and side-effect ports. |
| `makeApiKeys`, `ApiKeyStore`, `inMemoryApiKeyStore`, `ApiKeyPeppers` | Machine credentials: mint/verify/revoke with pepper-versioned HMAC hashes, scopes, pinning. |
| `makeTotp`, `matchTotpCode`, `verifyTotpCode`, `totpCode`, `generateTotpSecret`, `generateRecoveryCodes` | TOTP second factor: enrollment, one-time verification with lockout, recovery codes, session elevation, operator reset, sealing at rest. |
| `makeAuthorizationServer`, `OAuthServerStore`, `generateSigningKey` | OAuth 2.1 provider: clients, code+PKCE, refresh rotation with family revocation on reuse, revocation, introspection, JWKS, signature-verified access tokens, end-session hints. |
| `Auth*Error`, `InvalidAuthRoutes`, `RateLimitExceeded`, `UnsupportedPasskey` | Classified safe failures. |

See `test/` for executable password, magic-link, OAuth, passkey, rate-limit/audit, and HTTP examples.
