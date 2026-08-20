# @structure-ai/auth-pg

Durable PostgreSQL `AuthStore` for `@structure-ai/auth`, implemented with Bun's built-in `SQL` client. It adds no external database or authentication dependency.

## Usage

```ts
import { SQL } from "bun";
import { makeAuth } from "@structure-ai/auth";
import { makeAuthStore, migrate } from "@structure-ai/auth-pg";
import { Effect, Redacted } from "effect";

const sql = new SQL({
  adapter: "postgres",
  url: Redacted.value(settings.databaseUrl),
  max: 10,
});

// Run only in the deployment's designated migration process.
await Effect.runPromise(migrate(sql));

const auth = makeAuth({
  store: makeAuthStore(sql),
  // tenant configuration, email, rate limit, audit, and policy ports...
});
```

`tablePrefix` defaults to `auth_`. A unique prefix is also useful for integration-test isolation:

```ts
const options = { tablePrefix: "application_auth_" };
await Effect.runPromise(migrate(sql, options));
const store = makeAuthStore(sql, options);
```

## Guarantees

- User/password and user/OAuth creation use database transactions and tenant-scoped unique constraints.
- One-time tokens, OAuth states, and passkey challenges use atomic `DELETE ... RETURNING` consumption.
- Password replacement and all-session revocation commit in one transaction.
- Passkey counter updates compare the expected stored value and fail with `IdentityConflict` on races.
- Sessions and tokens contain only hashes supplied by `@structure-ai/auth`; raw bearer values never enter these tables.
- Foreign keys cascade user deletion into credentials and sessions.

PostgreSQL timestamps use `TIMESTAMPTZ`; passkey counters use `BIGINT` to hold the complete unsigned 32-bit WebAuthn counter range.

## Operations

`migrate` creates the initial schema idempotently in one transaction. Invoke it from one deploy job or designated migrator, not every serving instance. Future schema changes remain forward-only under the application's migration process.

Applications own pool sizing, connection timeouts, TLS, least-privilege database credentials, backups, and tenant-aware cleanup of expired rows. Close the Bun `SQL` pool during bounded application shutdown.

The package tests run against `DATABASE_URL` when it is present and skip otherwise.
