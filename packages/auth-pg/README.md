# @structure-ai/auth-pg

Durable PostgreSQL `AuthStore`, `ApiKeyStore`, and `OAuthServerStore` for `@structure-ai/auth`, implemented with Bun's built-in `SQL` client. It adds no external database or authentication dependency; `@effect/sql` is used only to express the schema migration.

## Usage

```ts
import { SQL } from "bun";
import { makeAuth } from "@structure-ai/auth";
import { makeAuthStore } from "@structure-ai/auth-pg";
import { Redacted } from "effect";

const sql = new SQL({
  adapter: "postgres",
  url: Redacted.value(settings.databaseUrl),
  max: 10,
});

// The schema must already exist (see "Schema migration") — stores never migrate.
const auth = makeAuth({
  store: makeAuthStore(sql),
  // tenant configuration, email, rate limit, audit, and policy ports...
});
```

`tablePrefix` defaults to `auth_`. A unique prefix is also useful for integration-test isolation:

```ts
const options = { tablePrefix: "application_auth_" };
const store = makeAuthStore(sql, options);
```

## Schema migration

`makeAuthStore`, `makeApiKeyStore`, and `makeOAuthServerStore` assume the schema exists and never migrate implicitly. Pick one migration workflow per deployment and run it only in the designated migration process (see `docs/operations.md`, "Migrations policy").

The `Migration` value carries a `checksum` computed like `defineMigration` with declared `sql` (sha-256 over id, name, and the DDL statements), so the migrator's drift detection covers the auth schema itself.

**In the application's `@structure-ai/migrations` set** (preferred: one set, one lock, one transaction next to the event store, jobs, and view-model migrations):

```ts
import {
  migration as authMigration,
  passkeyMetadataMigration,
} from "@structure-ai/auth-pg";
import { migrate as eventStoreMigrate } from "@structure-ai/eventsourcing-pg";
import { defineMigration, makeSet, run } from "@structure-ai/migrations";
import { ViewModel } from "@structure-ai/viewmodel";

const migrations = makeSet([
  defineMigration(1, "create_event_store", eventStoreMigrate()),
  authMigration(2), // or authMigration(2, { tablePrefix: "application_auth_" })
  passkeyMetadataMigration(3),
  ViewModel.migration(OrderSummary, 4),
]);

// designated migrator only, on the app's SqlClient (e.g. @effect/sql-pg PgClient.layer):
await Effect.runPromise(run(migrations).pipe(Effect.provide(PgClient.layer({ url }))));
```

`migration(id, options?)` is the frozen initial schema. `passkeyMetadataMigration(id, options?)` is the forward-only nullable `label` and `aaguid` upgrade. Existing applications add it under their next unused id and do not change the id of their applied `migration`. Both return an `Effect<void, SqlError, SqlClient>` in the same shape as a `Migration` from `@structure-ai/migrations`. The package does not depend on `@structure-ai/migrations`; a type-level test in `test/pg.test.ts` keeps the values structurally assignable.

**All-in-one over a Bun `SQL` handle** (apps without a migration set, and tests):

```ts
import { migrate } from "@structure-ai/auth-pg";

await Effect.runPromise(migrate(sql)); // one transaction, idempotent
```

Both workflows are idempotent (`CREATE ... IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`): a re-run is a no-op. The `DATABASE_URL`-gated suite asserts that `migrate` and the ordered migration pair produce byte-identical column, constraint, and index definitions.

## Exports

| Export | What it is |
| --- | --- |
| `makeAuthStore(sql, options?)` | `AuthStore` over a Bun `SQL` handle. |
| `makeApiKeyStore(sql, options?)` | `ApiKeyStore` over the same handle. |
| `makeOAuthServerStore(sql, options?)` | `OAuthServerStore` (OAuth 2.1 provider side). |
| `migration(id, options?)` | The schema as a `@structure-ai/migrations`-compatible `AuthMigration` over `SqlClient`. |
| `passkeyMetadataMigration(id, options?)` | Forward-only nullable passkey metadata upgrade over `SqlClient`. |
| `migrate(sql, options?)` | Create and upgrade the schema over a Bun `SQL` handle, in one transaction. |
| `tableNames(options?)` | Resolved table names for a prefix (tests drop them after a run). |
| `AdapterOptions`, `TableNames`, `AuthMigration` | Types. |

## Guarantees

- User/password and user/OAuth creation use database transactions and tenant-scoped unique constraints.
- One-time tokens, OAuth states, and passkey challenges use atomic `DELETE ... RETURNING` consumption.
- Password replacement and all-session revocation commit in one transaction.
- Passkey counter updates compare the expected stored value and fail with `IdentityConflict` on races.
- Passkey labels and AAGUIDs survive round trips. Rename and removal match tenant, user, and credential id.
- Sessions and tokens contain only hashes supplied by `@structure-ai/auth`; raw bearer values never enter these tables.
- Foreign keys cascade user deletion into credentials and sessions.

PostgreSQL timestamps use `TIMESTAMPTZ`; passkey counters use `BIGINT` to hold the complete unsigned 32-bit WebAuthn counter range.

## Operations

Run schema migrations from one deploy job or designated migrator, not every serving instance. `passkeyMetadataMigration` adds nullable columns without rewriting credentials or changing the checksum of the initial auth migration. Future application-owned schema changes remain new forward-only migrations in the application's set.

Applications own pool sizing, connection timeouts, TLS, least-privilege database credentials, backups, and tenant-aware cleanup of expired rows. Close the Bun `SQL` pool during bounded application shutdown.

The package tests run against `DATABASE_URL` when it is present and skip otherwise.
