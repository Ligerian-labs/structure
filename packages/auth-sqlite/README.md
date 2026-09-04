# @structure-ai/auth-sqlite

Durable SQLite `AuthStore` for `@structure-ai/auth`, implemented with Bun's built-in `SQL` client. It adds no external database or authentication dependency.

## Usage

```ts
import { SQL } from "bun";
import { makeAuth } from "@structure-ai/auth";
import { makeAuthStore, migrate } from "@structure-ai/auth-sqlite";
import { Effect } from "effect";

const sql = new SQL({ adapter: "sqlite", filename: "./auth.db" });

// Run only in the deployment's designated migration process.
await Effect.runPromise(migrate(sql));

const auth = makeAuth({
  store: makeAuthStore(sql),
  // tenant configuration, email, rate limit, audit, and policy ports...
});
```

`tablePrefix` defaults to `auth_` and scopes every table and index name:

```ts
const options = { tablePrefix: "application_auth_" };
await Effect.runPromise(migrate(sql, options));
const store = makeAuthStore(sql, options);
```

## Guarantees

- User/password and user/OAuth creation use database transactions and tenant-scoped uniqueness.
- One-time tokens, OAuth states, and passkey challenges use atomic `DELETE ... RETURNING` consumption.
- Password replacement and all-session revocation commit in one transaction.
- Passkey labels and AAGUIDs survive round trips. Rename and removal match tenant, user, and credential id; counter updates compare the expected stored value and fail with `IdentityConflict` on races.
- Sessions and tokens contain only hashes supplied by `@structure-ai/auth`; raw bearer values never enter these tables.
- Foreign keys cascade user deletion into credentials and sessions.

The adapter stores UTC timestamps as ISO text so lexical expiry comparisons remain chronological. SQLite foreign keys are enabled by `migrate`; keep them enabled if application code changes connection pragmas later.

## Operations

`migrate` creates the schema idempotently in one transaction and adds nullable passkey metadata columns to older auth tables without rewriting credentials. Invoke it from one deploy job or designated migrator, not every serving instance. Future schema changes remain forward-only under the application's migration process.

Applications must schedule tenant-aware deletion of expired rows from tokens, sessions, OAuth states, and passkey challenges. Close the Bun `SQL` connection during bounded application shutdown.
