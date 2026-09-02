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
}

export const tableNames = (options: AdapterOptions = {}): TableNames => {
  const prefix = options.tablePrefix ?? "auth_";
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
  };
};

/** Creates the complete auth schema in one transaction. Run from the designated migrator. */
export const migrate = (
  sql: SQL,
  options: AdapterOptions = {},
): Effect.Effect<void, AuthStoreError> =>
  Effect.tryPromise({
    try: async () => {
      const tables = tableNames(options);
      await sql`PRAGMA foreign_keys = ON`;
      await sql.begin(async (tx) => {
        await tx`
          CREATE TABLE IF NOT EXISTS ${tx(tables.users)} (
            tenant_id TEXT NOT NULL,
            id TEXT NOT NULL,
            email TEXT,
            email_verified INTEGER NOT NULL CHECK (email_verified IN (0, 1)),
            display_name TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (tenant_id, id),
            UNIQUE (tenant_id, email)
          )
        `;
        await tx`
          CREATE TABLE IF NOT EXISTS ${tx(tables.passwords)} (
            tenant_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            email TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (tenant_id, user_id),
            UNIQUE (tenant_id, email),
            FOREIGN KEY (tenant_id, user_id)
              REFERENCES ${tx(tables.users)} (tenant_id, id) ON DELETE CASCADE
          )
        `;
        await tx`
          CREATE TABLE IF NOT EXISTS ${tx(tables.tokens)} (
            tenant_id TEXT NOT NULL,
            purpose TEXT NOT NULL CHECK (
              purpose IN ('email-verification', 'magic-link', 'password-reset')
            ),
            token_hash TEXT NOT NULL,
            email TEXT NOT NULL,
            user_id TEXT,
            expires_at TEXT NOT NULL,
            PRIMARY KEY (tenant_id, purpose, token_hash),
            UNIQUE (tenant_id, purpose, email)
          )
        `;
        await tx`
          CREATE TABLE IF NOT EXISTS ${tx(tables.sessions)} (
            tenant_id TEXT NOT NULL,
            id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            token_hash TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            elevated_at TEXT,
            PRIMARY KEY (tenant_id, token_hash),
            UNIQUE (tenant_id, id),
            FOREIGN KEY (tenant_id, user_id)
              REFERENCES ${tx(tables.users)} (tenant_id, id) ON DELETE CASCADE
          )
        `;
        await tx`ALTER TABLE ${tx(tables.sessions)} ADD COLUMN elevated_at TEXT`.catch(
          () => undefined,
        );
        await tx`
          CREATE TABLE IF NOT EXISTS ${tx(tables.oauthStates)} (
            tenant_id TEXT NOT NULL,
            provider TEXT NOT NULL,
            state_hash TEXT NOT NULL,
            code_verifier TEXT NOT NULL,
            redirect_uri TEXT NOT NULL,
            return_to TEXT,
            expires_at TEXT NOT NULL,
            PRIMARY KEY (tenant_id, state_hash)
          )
        `;
        await tx`
          CREATE TABLE IF NOT EXISTS ${tx(tables.oauthIdentities)} (
            tenant_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            provider TEXT NOT NULL,
            subject TEXT NOT NULL,
            email TEXT,
            created_at TEXT NOT NULL,
            PRIMARY KEY (tenant_id, provider, subject),
            FOREIGN KEY (tenant_id, user_id)
              REFERENCES ${tx(tables.users)} (tenant_id, id) ON DELETE CASCADE
          )
        `;
        await tx`
          CREATE TABLE IF NOT EXISTS ${tx(tables.passkeyChallenges)} (
            tenant_id TEXT NOT NULL,
            purpose TEXT NOT NULL CHECK (purpose IN ('registration', 'authentication')),
            challenge_hash TEXT NOT NULL,
            user_id TEXT,
            expires_at TEXT NOT NULL,
            PRIMARY KEY (tenant_id, purpose, challenge_hash)
          )
        `;
        await tx`
          CREATE TABLE IF NOT EXISTS ${tx(tables.passkeys)} (
            tenant_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            credential_id TEXT NOT NULL,
            public_key TEXT NOT NULL,
            algorithm TEXT NOT NULL CHECK (algorithm IN ('ES256', 'RS256', 'Ed25519')),
            counter INTEGER NOT NULL CHECK (counter >= 0),
            transports TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (tenant_id, credential_id),
            FOREIGN KEY (tenant_id, user_id)
              REFERENCES ${tx(tables.users)} (tenant_id, id) ON DELETE CASCADE
          )
        `;
        await tx`
          CREATE INDEX IF NOT EXISTS ${tx(`${tables.sessions}_user_idx`)}
          ON ${tx(tables.sessions)} (tenant_id, user_id)
        `;
        await tx`
          CREATE INDEX IF NOT EXISTS ${tx(`${tables.sessions}_expiry_idx`)}
          ON ${tx(tables.sessions)} (expires_at)
        `;
        await tx`
          CREATE INDEX IF NOT EXISTS ${tx(`${tables.tokens}_expiry_idx`)}
          ON ${tx(tables.tokens)} (expires_at)
        `;
        await tx`
          CREATE TABLE IF NOT EXISTS ${tx(tables.totp)} (
            tenant_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            secret_base32 TEXT NOT NULL,
            confirmed INTEGER NOT NULL CHECK (confirmed IN (0, 1)),
            recovery_code_hashes TEXT NOT NULL,
            failed_attempts INTEGER NOT NULL CHECK (failed_attempts >= 0),
            locked_until TEXT,
            enrolled_at TEXT NOT NULL,
            PRIMARY KEY (tenant_id, user_id),
            FOREIGN KEY (tenant_id, user_id)
              REFERENCES ${tx(tables.users)} (tenant_id, id) ON DELETE CASCADE
          )
        `;
        await tx`
          CREATE INDEX IF NOT EXISTS ${tx(`${tables.passkeys}_user_idx`)}
          ON ${tx(tables.passkeys)} (tenant_id, user_id)
        `;
        await tx`
          CREATE TABLE IF NOT EXISTS ${tx(tables.apiKeys)} (
            tenant_id TEXT NOT NULL,
            key_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            name TEXT,
            scopes TEXT NOT NULL,
            secret_hash TEXT NOT NULL,
            pepper_version INTEGER NOT NULL CHECK (pepper_version >= 1),
            workspace_id TEXT,
            expires_at TEXT,
            created_at TEXT NOT NULL,
            last_used_at TEXT,
            revoked_at TEXT,
            PRIMARY KEY (tenant_id, key_id)
          )
        `;
        await tx`
          CREATE INDEX IF NOT EXISTS ${tx(`${tables.apiKeys}_user_idx`)}
          ON ${tx(tables.apiKeys)} (tenant_id, user_id)
        `;
      });
    },
    catch: (cause) => new AuthStoreError({ operation: "migrate-sqlite-auth", cause }),
  });
