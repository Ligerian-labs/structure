import { createHash } from "node:crypto";
import * as SqlClient from "@effect/sql/SqlClient";
import type { SqlError } from "@effect/sql/SqlError";
import { AuthStoreError } from "@structure-ai/auth";
import type { SQL } from "bun";
import { Effect } from "effect";

export interface AdapterOptions {
  /** Prefix prepended to every table name. Defaults to `auth_`. */
  readonly tablePrefix?: string;
}

export interface TableNames {
  readonly users: string;
  readonly passwords: string;
  readonly tokens: string;
  readonly sessions: string;
  readonly oauthStates: string;
  readonly oauthIdentities: string;
  readonly passkeyChallenges: string;
  readonly passkeys: string;
  readonly apiKeys: string;
  readonly totp: string;
  readonly oauthClients: string;
  readonly oauthCodes: string;
  readonly oauthConsents: string;
  readonly oauthTokens: string;
  readonly oauthEndSessionHints: string;
}

const DEFAULT_PREFIX = "auth_";

export const tableNames = (options: AdapterOptions = {}): TableNames => {
  const prefix = options.tablePrefix ?? DEFAULT_PREFIX;
  return {
    users: `${prefix}users`,
    passwords: `${prefix}passwords`,
    tokens: `${prefix}tokens`,
    sessions: `${prefix}sessions`,
    oauthStates: `${prefix}oauth_states`,
    oauthIdentities: `${prefix}oauth_identities`,
    passkeyChallenges: `${prefix}passkey_challenges`,
    passkeys: `${prefix}passkeys`,
    apiKeys: `${prefix}api_keys`,
    totp: `${prefix}totp`,
    oauthClients: `${prefix}oauth2_clients`,
    oauthCodes: `${prefix}oauth2_codes`,
    oauthConsents: `${prefix}oauth2_consents`,
    oauthTokens: `${prefix}oauth2_tokens`,
    oauthEndSessionHints: `${prefix}oauth2_endsession_hints`,
  };
};

/** Double-quoted SQL identifier, the same quoting Bun `sql(name)` and `@effect/sql` `sql(name)` apply. */
const ident = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/**
 * The complete auth schema as ordered, idempotent DDL statements for one
 * table prefix. Single source for both entry points (`migrate` over Bun
 * `SQL`, `migration` over `SqlClient`), so the two cannot drift.
 */
export const schemaStatements = (options: AdapterOptions = {}): ReadonlyArray<string> => {
  const t = tableNames(options);
  return [
    `CREATE TABLE IF NOT EXISTS ${ident(t.users)} (
      tenant_id TEXT NOT NULL,
      id TEXT NOT NULL,
      email TEXT,
      email_verified BOOLEAN NOT NULL,
      display_name TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (tenant_id, id),
      UNIQUE (tenant_id, email)
    )`,
    `CREATE TABLE IF NOT EXISTS ${ident(t.passwords)} (
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (tenant_id, user_id),
      UNIQUE (tenant_id, email),
      FOREIGN KEY (tenant_id, user_id)
        REFERENCES ${ident(t.users)} (tenant_id, id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS ${ident(t.tokens)} (
      tenant_id TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK (
        purpose IN ('email-verification', 'magic-link', 'password-reset')
      ),
      token_hash TEXT NOT NULL,
      email TEXT NOT NULL,
      user_id TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (tenant_id, purpose, token_hash),
      UNIQUE (tenant_id, purpose, email)
    )`,
    `CREATE TABLE IF NOT EXISTS ${ident(t.sessions)} (
      tenant_id TEXT NOT NULL,
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      elevated_at TIMESTAMPTZ,
      PRIMARY KEY (tenant_id, token_hash),
      UNIQUE (tenant_id, id),
      FOREIGN KEY (tenant_id, user_id)
        REFERENCES ${ident(t.users)} (tenant_id, id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS ${ident(t.oauthStates)} (
      tenant_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      state_hash TEXT NOT NULL,
      code_verifier TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      return_to TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (tenant_id, state_hash)
    )`,
    `CREATE TABLE IF NOT EXISTS ${ident(t.oauthIdentities)} (
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      subject TEXT NOT NULL,
      email TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (tenant_id, provider, subject),
      FOREIGN KEY (tenant_id, user_id)
        REFERENCES ${ident(t.users)} (tenant_id, id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS ${ident(t.passkeyChallenges)} (
      tenant_id TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK (purpose IN ('registration', 'authentication')),
      challenge_hash TEXT NOT NULL,
      user_id TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (tenant_id, purpose, challenge_hash)
    )`,
    `CREATE TABLE IF NOT EXISTS ${ident(t.passkeys)} (
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      credential_id TEXT NOT NULL,
      public_key TEXT NOT NULL,
      algorithm TEXT NOT NULL CHECK (algorithm IN ('ES256', 'RS256', 'Ed25519')),
      counter BIGINT NOT NULL CHECK (counter >= 0),
      transports TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (tenant_id, credential_id),
      FOREIGN KEY (tenant_id, user_id)
        REFERENCES ${ident(t.users)} (tenant_id, id) ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS ${ident(`${t.sessions}_user_idx`)}
      ON ${ident(t.sessions)} (tenant_id, user_id)`,
    `CREATE INDEX IF NOT EXISTS ${ident(`${t.sessions}_expiry_idx`)}
      ON ${ident(t.sessions)} (expires_at)`,
    `CREATE INDEX IF NOT EXISTS ${ident(`${t.tokens}_expiry_idx`)}
      ON ${ident(t.tokens)} (expires_at)`,
    `CREATE TABLE IF NOT EXISTS ${ident(t.totp)} (
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      secret_base32 TEXT NOT NULL,
      confirmed BOOLEAN NOT NULL,
      recovery_code_hashes TEXT NOT NULL,
      failed_attempts INTEGER NOT NULL CHECK (failed_attempts >= 0),
      locked_until TIMESTAMPTZ,
      enrolled_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (tenant_id, user_id),
      FOREIGN KEY (tenant_id, user_id)
        REFERENCES ${ident(t.users)} (tenant_id, id) ON DELETE CASCADE
    )`,
    // Upgrade path for sessions tables created before step-up sessions existed.
    `ALTER TABLE ${ident(t.sessions)} ADD COLUMN IF NOT EXISTS elevated_at TIMESTAMPTZ`,
    `CREATE TABLE IF NOT EXISTS ${ident(t.oauthClients)} (
      tenant_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      client_name TEXT,
      client_type TEXT NOT NULL CHECK (client_type IN ('confidential', 'public')),
      secret_hash TEXT,
      redirect_uris TEXT NOT NULL,
      scopes TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (tenant_id, client_id)
    )`,
    `CREATE TABLE IF NOT EXISTS ${ident(t.oauthCodes)} (
      tenant_id TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      client_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      scope TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      PRIMARY KEY (tenant_id, code_hash)
    )`,
    `CREATE TABLE IF NOT EXISTS ${ident(t.oauthConsents)} (
      tenant_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      granted_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (tenant_id, client_id, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS ${ident(t.oauthTokens)} (
      tenant_id TEXT NOT NULL,
      token_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
      client_id TEXT NOT NULL,
      user_id TEXT,
      scope TEXT NOT NULL,
      token_hash TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (tenant_id, token_id)
    )`,
    `CREATE INDEX IF NOT EXISTS ${ident(`${t.oauthTokens}_hash_idx`)}
      ON ${ident(t.oauthTokens)} (tenant_id, token_hash)`,
    `CREATE TABLE IF NOT EXISTS ${ident(t.oauthEndSessionHints)} (
      tenant_id TEXT NOT NULL,
      hint_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      PRIMARY KEY (tenant_id, hint_hash)
    )`,
    `CREATE INDEX IF NOT EXISTS ${ident(`${t.passkeys}_user_idx`)}
      ON ${ident(t.passkeys)} (tenant_id, user_id)`,
    `CREATE TABLE IF NOT EXISTS ${ident(t.apiKeys)} (
      tenant_id TEXT NOT NULL,
      key_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT,
      scopes TEXT NOT NULL,
      secret_hash TEXT NOT NULL,
      pepper_version INTEGER NOT NULL CHECK (pepper_version >= 1),
      workspace_id TEXT,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL,
      last_used_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      PRIMARY KEY (tenant_id, key_id)
    )`,
    `CREATE INDEX IF NOT EXISTS ${ident(`${t.apiKeys}_user_idx`)}
      ON ${ident(t.apiKeys)} (tenant_id, user_id)`,
  ];
};

/** Additive passkey display metadata upgrade for an existing auth schema. */
export const passkeyMetadataStatements = (options: AdapterOptions = {}): ReadonlyArray<string> => {
  const passkeys = tableNames(options).passkeys;
  return [
    `ALTER TABLE ${ident(passkeys)} ADD COLUMN IF NOT EXISTS label TEXT`,
    `ALTER TABLE ${ident(passkeys)} ADD COLUMN IF NOT EXISTS aaguid TEXT`,
  ];
};

/**
 * Structurally identical to `@structure-ai/migrations`' `Migration`, so the
 * value drops into `makeSet([...])` without this package depending on the
 * migrations package (auth is a standalone foundation).
 */
export interface AuthMigration {
  readonly id: number;
  readonly name: string;
  readonly up: Effect.Effect<void, SqlError, SqlClient.SqlClient>;
  /**
   * sha-256 (hex) over the JSON encoding of `[id, name, statements]` — the
   * same recipe as `defineMigration` with declared `sql`, so the migrator's
   * drift detection covers the auth DDL itself.
   */
  readonly checksum: string;
}

const makeMigration = (
  id: number,
  name: string,
  statements: ReadonlyArray<string>,
): AuthMigration => {
  return {
    id,
    name,
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.forEach(statements, (statement) => sql.unsafe(statement), { discard: true }),
      );
    }),
    checksum: createHash("sha256")
      .update(JSON.stringify([id, name, [...statements]]))
      .digest("hex"),
  };
};

/**
 * The frozen initial auth schema over the `SqlClient` in context. Add later
 * package migrations separately so existing checksums remain valid.
 */
export const migration = (id: number, options: AdapterOptions = {}): AuthMigration =>
  makeMigration(
    id,
    `create_${options.tablePrefix ?? DEFAULT_PREFIX}schema`,
    schemaStatements(options),
  );

/**
 * Forward-only upgrade that adds nullable passkey display metadata. Place it
 * after `migration` in the application's migration set.
 */
export const passkeyMetadataMigration = (id: number, options: AdapterOptions = {}): AuthMigration =>
  makeMigration(
    id,
    `add_${options.tablePrefix ?? DEFAULT_PREFIX}passkey_metadata`,
    passkeyMetadataStatements(options),
  );

/**
 * Creates and upgrades the complete auth schema in one transaction over a
 * Bun `SQL` handle. Run it from the designated migrator; stores never migrate.
 */
export const migrate = (
  sql: SQL,
  options: AdapterOptions = {},
): Effect.Effect<void, AuthStoreError> =>
  Effect.tryPromise({
    try: async () => {
      await sql.begin(async (tx) => {
        const statements = [...schemaStatements(options), ...passkeyMetadataStatements(options)];
        for (const statement of statements) {
          await tx.unsafe(statement);
        }
      });
    },
    catch: (cause) => new AuthStoreError({ operation: "migrate-postgres-auth", cause }),
  });
