import {
  type AuthStore,
  AuthStoreError,
  type AuthUser,
  IdentityConflict,
  type OAuthIdentity,
  type OAuthProviderId,
  type OAuthStateRecord,
  type OneTimeTokenPurpose,
  type OneTimeTokenRecord,
  type PasskeyAlgorithm,
  type PasskeyChallengePurpose,
  type PasskeyChallengeRecord,
  type PasskeyRecord,
  type PasswordCredential,
  type SessionRecord,
} from "@structure-ai/auth";
import type { SQL } from "bun";
import { Effect, Redacted } from "effect";
import { type AdapterOptions, tableNames } from "./schema.js";

type DateValue = Date | string;

interface UserRow {
  readonly tenant_id: string;
  readonly id: string;
  readonly email: string | null;
  readonly email_verified: boolean | number;
  readonly display_name: string | null;
  readonly created_at: DateValue;
  readonly updated_at: DateValue;
}

interface PasswordRow {
  readonly tenant_id: string;
  readonly user_id: string;
  readonly email: string;
  readonly password_hash: string;
  readonly updated_at: DateValue;
}

interface TokenRow {
  readonly tenant_id: string;
  readonly purpose: OneTimeTokenPurpose;
  readonly token_hash: string;
  readonly email: string;
  readonly user_id: string | null;
  readonly expires_at: DateValue;
}

interface SessionRow {
  readonly tenant_id: string;
  readonly id: string;
  readonly user_id: string;
  readonly token_hash: string;
  readonly created_at: DateValue;
  readonly expires_at: DateValue;
}

interface OAuthStateRow {
  readonly tenant_id: string;
  readonly provider: OAuthProviderId;
  readonly state_hash: string;
  readonly code_verifier: string;
  readonly redirect_uri: string;
  readonly return_to: string | null;
  readonly expires_at: DateValue;
}

interface OAuthIdentityRow {
  readonly tenant_id: string;
  readonly user_id: string;
  readonly provider: OAuthProviderId;
  readonly subject: string;
  readonly email: string | null;
  readonly created_at: DateValue;
}

interface PasskeyChallengeRow {
  readonly tenant_id: string;
  readonly purpose: PasskeyChallengePurpose;
  readonly challenge_hash: string;
  readonly user_id: string | null;
  readonly expires_at: DateValue;
}

interface PasskeyRow {
  readonly tenant_id: string;
  readonly user_id: string;
  readonly credential_id: string;
  readonly public_key: string;
  readonly algorithm: PasskeyAlgorithm;
  readonly counter: number;
  readonly transports: string;
  readonly created_at: DateValue;
}

const date = (value: DateValue): Date => (value instanceof Date ? value : new Date(value));

const decodeUser = (row: UserRow): AuthUser => ({
  id: row.id,
  tenantId: row.tenant_id,
  ...(row.email === null ? {} : { email: row.email }),
  emailVerified: row.email_verified === true || row.email_verified === 1,
  ...(row.display_name === null ? {} : { displayName: row.display_name }),
  createdAt: date(row.created_at),
  updatedAt: date(row.updated_at),
});

const decodePassword = (row: PasswordRow): PasswordCredential => ({
  tenantId: row.tenant_id,
  userId: row.user_id,
  email: row.email,
  passwordHash: row.password_hash,
  updatedAt: date(row.updated_at),
});

const decodeToken = (row: TokenRow): OneTimeTokenRecord => ({
  tenantId: row.tenant_id,
  purpose: row.purpose,
  tokenHash: row.token_hash,
  email: row.email,
  ...(row.user_id === null ? {} : { userId: row.user_id }),
  expiresAt: date(row.expires_at),
});

const decodeSession = (row: SessionRow): SessionRecord => ({
  id: row.id,
  tenantId: row.tenant_id,
  userId: row.user_id,
  tokenHash: row.token_hash,
  createdAt: date(row.created_at),
  expiresAt: date(row.expires_at),
});

const decodeOAuthState = (row: OAuthStateRow): OAuthStateRecord => ({
  tenantId: row.tenant_id,
  provider: row.provider,
  stateHash: row.state_hash,
  codeVerifier: Redacted.make(row.code_verifier),
  redirectUri: row.redirect_uri,
  ...(row.return_to === null ? {} : { returnTo: row.return_to }),
  expiresAt: date(row.expires_at),
});

const decodeOAuthIdentity = (row: OAuthIdentityRow): OAuthIdentity => ({
  tenantId: row.tenant_id,
  userId: row.user_id,
  provider: row.provider,
  subject: row.subject,
  ...(row.email === null ? {} : { email: row.email }),
  createdAt: date(row.created_at),
});

const decodeChallenge = (row: PasskeyChallengeRow): PasskeyChallengeRecord => ({
  tenantId: row.tenant_id,
  purpose: row.purpose,
  challengeHash: row.challenge_hash,
  ...(row.user_id === null ? {} : { userId: row.user_id }),
  expiresAt: date(row.expires_at),
});

const decodeTransports = (value: string): ReadonlyArray<string> => {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new Error("stored passkey transports are invalid");
  }
  return parsed;
};

const decodePasskey = (row: PasskeyRow): PasskeyRecord => ({
  tenantId: row.tenant_id,
  userId: row.user_id,
  credentialId: row.credential_id,
  publicKey: row.public_key,
  algorithm: row.algorithm,
  counter: Number(row.counter),
  transports: decodeTransports(row.transports),
  createdAt: date(row.created_at),
});

const errorIdentifier = (cause: unknown, field: "code" | "errno"): string | undefined => {
  if (typeof cause !== "object" || cause === null) return undefined;
  const value =
    field === "code"
      ? "code" in cause
        ? cause.code
        : undefined
      : "errno" in cause
        ? cause.errno
        : undefined;
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
};

const isUniqueViolation = (cause: unknown): boolean => {
  const code = errorIdentifier(cause, "code");
  const errno = errorIdentifier(cause, "errno");
  return (
    errno === "23505" ||
    code === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
    code === "SQLITE_CONSTRAINT_UNIQUE"
  );
};

const read = <A>(operation: string, query: () => Promise<A>): Effect.Effect<A, AuthStoreError> =>
  Effect.tryPromise({
    try: query,
    catch: (cause) => new AuthStoreError({ operation, cause }),
  });

const write = <A>(
  operation: string,
  tenantId: string,
  identity: string,
  query: () => Promise<A>,
): Effect.Effect<A, AuthStoreError | IdentityConflict> =>
  Effect.tryPromise({
    try: query,
    catch: (cause) =>
      isUniqueViolation(cause)
        ? new IdentityConflict({ tenantId, identity })
        : new AuthStoreError({ operation, cause }),
  });

/** Builds an AuthStore over an already-migrated Bun SQL connection. */
export const makeAuthStore = (sql: SQL, options: AdapterOptions = {}): AuthStore => {
  const tables = tableNames(options);

  const insertUser = (client: SQL, user: AuthUser): Promise<unknown> =>
    client`
      INSERT INTO ${client(tables.users)}
        (tenant_id, id, email, email_verified, display_name, created_at, updated_at)
      VALUES
        (${user.tenantId}, ${user.id}, ${user.email ?? null}, ${user.emailVerified},
         ${user.displayName ?? null}, ${user.createdAt.toISOString()}, ${user.updatedAt.toISOString()})
    `;

  return {
    createPasswordUser: (user, credential) =>
      write("create-password-user", user.tenantId, "password-email", () =>
        sql.begin(async (tx) => {
          await insertUser(tx, user);
          await tx`
            INSERT INTO ${tx(tables.passwords)}
              (tenant_id, user_id, email, password_hash, updated_at)
            VALUES
              (${credential.tenantId}, ${credential.userId}, ${credential.email},
               ${credential.passwordHash}, ${credential.updatedAt.toISOString()})
          `;
        }),
      ).pipe(Effect.asVoid),
    createOAuthUser: (user, identity) =>
      write("create-oauth-user", user.tenantId, "oauth", () =>
        sql.begin(async (tx) => {
          await insertUser(tx, user);
          await tx`
            INSERT INTO ${tx(tables.oauthIdentities)}
              (tenant_id, user_id, provider, subject, email, created_at)
            VALUES
              (${identity.tenantId}, ${identity.userId}, ${identity.provider}, ${identity.subject},
               ${identity.email ?? null}, ${identity.createdAt.toISOString()})
          `;
        }),
      ).pipe(Effect.asVoid),
    createMagicLinkUser: (user) =>
      write("create-magic-link-user", user.tenantId, "email", () => insertUser(sql, user)).pipe(
        Effect.asVoid,
      ),
    findUserById: (tenantId, userId) =>
      read("find-user-by-id", async () => {
        const rows = await sql<UserRow[]>`
          SELECT tenant_id, id, email, email_verified, display_name, created_at, updated_at
          FROM ${sql(tables.users)}
          WHERE tenant_id = ${tenantId} AND id = ${userId}
        `;
        return rows[0] === undefined ? undefined : decodeUser(rows[0]);
      }),
    findUserByEmail: (tenantId, email) =>
      read("find-user-by-email", async () => {
        const rows = await sql<UserRow[]>`
          SELECT tenant_id, id, email, email_verified, display_name, created_at, updated_at
          FROM ${sql(tables.users)}
          WHERE tenant_id = ${tenantId} AND email = ${email}
        `;
        return rows[0] === undefined ? undefined : decodeUser(rows[0]);
      }),
    findPassword: (tenantId, email) =>
      read("find-password", async () => {
        const rows = await sql<PasswordRow[]>`
          SELECT tenant_id, user_id, email, password_hash, updated_at
          FROM ${sql(tables.passwords)}
          WHERE tenant_id = ${tenantId} AND email = ${email}
        `;
        return rows[0] === undefined ? undefined : decodePassword(rows[0]);
      }),
    setEmailVerified: (tenantId, userId, now) =>
      read("set-email-verified", async () => {
        const rows = await sql<UserRow[]>`
          UPDATE ${sql(tables.users)}
          SET email_verified = ${true}, updated_at = ${now.toISOString()}
          WHERE tenant_id = ${tenantId} AND id = ${userId}
          RETURNING tenant_id, id, email, email_verified, display_name, created_at, updated_at
        `;
        return rows[0] === undefined ? undefined : decodeUser(rows[0]);
      }),
    replacePasswordAndRevokeSessions: (tenantId, userId, passwordHash, now) =>
      read("replace-password-and-revoke-sessions", () =>
        sql.begin(async (tx) => {
          await tx`
            UPDATE ${tx(tables.passwords)}
            SET password_hash = ${passwordHash}, updated_at = ${now.toISOString()}
            WHERE tenant_id = ${tenantId} AND user_id = ${userId}
          `;
          await tx`
            DELETE FROM ${tx(tables.sessions)}
            WHERE tenant_id = ${tenantId} AND user_id = ${userId}
          `;
        }),
      ).pipe(Effect.asVoid),
    putOneTimeToken: (record) =>
      write("put-one-time-token", record.tenantId, "one-time-token", async () => {
        await sql`
          INSERT INTO ${sql(tables.tokens)}
            (tenant_id, purpose, token_hash, email, user_id, expires_at)
          VALUES
            (${record.tenantId}, ${record.purpose}, ${record.tokenHash}, ${record.email},
             ${record.userId ?? null}, ${record.expiresAt.toISOString()})
          ON CONFLICT (tenant_id, purpose, email) DO UPDATE SET
            token_hash = excluded.token_hash,
            user_id = excluded.user_id,
            expires_at = excluded.expires_at
        `;
      }).pipe(Effect.asVoid),
    consumeOneTimeToken: (tenantId, purpose, tokenHash, now) =>
      read("consume-one-time-token", async () => {
        const rows = await sql<TokenRow[]>`
          DELETE FROM ${sql(tables.tokens)}
          WHERE tenant_id = ${tenantId} AND purpose = ${purpose} AND token_hash = ${tokenHash}
          RETURNING tenant_id, purpose, token_hash, email, user_id, expires_at
        `;
        const record = rows[0] === undefined ? undefined : decodeToken(rows[0]);
        return record === undefined || record.expiresAt.getTime() <= now.getTime()
          ? undefined
          : record;
      }),
    createSession: (record) =>
      write("create-session", record.tenantId, "session-token", async () => {
        await sql`
          INSERT INTO ${sql(tables.sessions)}
            (tenant_id, id, user_id, token_hash, created_at, expires_at)
          VALUES
            (${record.tenantId}, ${record.id}, ${record.userId}, ${record.tokenHash},
             ${record.createdAt.toISOString()}, ${record.expiresAt.toISOString()})
        `;
      }).pipe(Effect.asVoid),
    findSession: (tenantId, tokenHash, now) =>
      read("find-session", async () => {
        const rows = await sql<SessionRow[]>`
          SELECT tenant_id, id, user_id, token_hash, created_at, expires_at
          FROM ${sql(tables.sessions)}
          WHERE tenant_id = ${tenantId} AND token_hash = ${tokenHash}
            AND expires_at > ${now.toISOString()}
        `;
        return rows[0] === undefined ? undefined : decodeSession(rows[0]);
      }),
    revokeSession: (tenantId, tokenHash) =>
      read("revoke-session", async () => {
        await sql`
          DELETE FROM ${sql(tables.sessions)}
          WHERE tenant_id = ${tenantId} AND token_hash = ${tokenHash}
        `;
      }).pipe(Effect.asVoid),
    revokeUserSessions: (tenantId, userId) =>
      read("revoke-user-sessions", async () => {
        await sql`
          DELETE FROM ${sql(tables.sessions)}
          WHERE tenant_id = ${tenantId} AND user_id = ${userId}
        `;
      }).pipe(Effect.asVoid),
    putOAuthState: (record) =>
      write("put-oauth-state", record.tenantId, "oauth-state", async () => {
        await sql`
          INSERT INTO ${sql(tables.oauthStates)}
            (tenant_id, provider, state_hash, code_verifier, redirect_uri, return_to, expires_at)
          VALUES
            (${record.tenantId}, ${record.provider}, ${record.stateHash},
             ${Redacted.value(record.codeVerifier)}, ${record.redirectUri},
             ${record.returnTo ?? null}, ${record.expiresAt.toISOString()})
          ON CONFLICT (tenant_id, state_hash) DO UPDATE SET
            provider = excluded.provider,
            code_verifier = excluded.code_verifier,
            redirect_uri = excluded.redirect_uri,
            return_to = excluded.return_to,
            expires_at = excluded.expires_at
        `;
      }).pipe(Effect.asVoid),
    consumeOAuthState: (tenantId, stateHash, now) =>
      read("consume-oauth-state", async () => {
        const rows = await sql<OAuthStateRow[]>`
          DELETE FROM ${sql(tables.oauthStates)}
          WHERE tenant_id = ${tenantId} AND state_hash = ${stateHash}
          RETURNING tenant_id, provider, state_hash, code_verifier, redirect_uri, return_to,
                    expires_at
        `;
        const record = rows[0] === undefined ? undefined : decodeOAuthState(rows[0]);
        return record === undefined || record.expiresAt.getTime() <= now.getTime()
          ? undefined
          : record;
      }),
    findOAuthIdentity: (tenantId, provider, subject) =>
      read("find-oauth-identity", async () => {
        const rows = await sql<OAuthIdentityRow[]>`
          SELECT tenant_id, user_id, provider, subject, email, created_at
          FROM ${sql(tables.oauthIdentities)}
          WHERE tenant_id = ${tenantId} AND provider = ${provider} AND subject = ${subject}
        `;
        return rows[0] === undefined ? undefined : decodeOAuthIdentity(rows[0]);
      }),
    addOAuthIdentity: (identity) =>
      write("add-oauth-identity", identity.tenantId, "oauth", async () => {
        await sql`
          INSERT INTO ${sql(tables.oauthIdentities)}
            (tenant_id, user_id, provider, subject, email, created_at)
          VALUES
            (${identity.tenantId}, ${identity.userId}, ${identity.provider}, ${identity.subject},
             ${identity.email ?? null}, ${identity.createdAt.toISOString()})
        `;
      }).pipe(Effect.asVoid),
    putPasskeyChallenge: (record) =>
      write("put-passkey-challenge", record.tenantId, "passkey-challenge", async () => {
        await sql`
          INSERT INTO ${sql(tables.passkeyChallenges)}
            (tenant_id, purpose, challenge_hash, user_id, expires_at)
          VALUES
            (${record.tenantId}, ${record.purpose}, ${record.challengeHash},
             ${record.userId ?? null}, ${record.expiresAt.toISOString()})
          ON CONFLICT (tenant_id, purpose, challenge_hash) DO UPDATE SET
            user_id = excluded.user_id,
            expires_at = excluded.expires_at
        `;
      }).pipe(Effect.asVoid),
    consumePasskeyChallenge: (tenantId, purpose, challengeHash, now) =>
      read("consume-passkey-challenge", async () => {
        const rows = await sql<PasskeyChallengeRow[]>`
          DELETE FROM ${sql(tables.passkeyChallenges)}
          WHERE tenant_id = ${tenantId} AND purpose = ${purpose}
            AND challenge_hash = ${challengeHash}
          RETURNING tenant_id, purpose, challenge_hash, user_id, expires_at
        `;
        const record = rows[0] === undefined ? undefined : decodeChallenge(rows[0]);
        return record === undefined || record.expiresAt.getTime() <= now.getTime()
          ? undefined
          : record;
      }),
    addPasskey: (record) =>
      write("add-passkey", record.tenantId, "passkey", async () => {
        await sql`
          INSERT INTO ${sql(tables.passkeys)}
            (tenant_id, user_id, credential_id, public_key, algorithm, counter, transports,
             created_at)
          VALUES
            (${record.tenantId}, ${record.userId}, ${record.credentialId}, ${record.publicKey},
             ${record.algorithm}, ${record.counter}, ${JSON.stringify(record.transports)},
             ${record.createdAt.toISOString()})
        `;
      }).pipe(Effect.asVoid),
    findPasskey: (tenantId, credentialId) =>
      read("find-passkey", async () => {
        const rows = await sql<PasskeyRow[]>`
          SELECT tenant_id, user_id, credential_id, public_key, algorithm, counter, transports,
                 created_at
          FROM ${sql(tables.passkeys)}
          WHERE tenant_id = ${tenantId} AND credential_id = ${credentialId}
        `;
        return rows[0] === undefined ? undefined : decodePasskey(rows[0]);
      }),
    listPasskeys: (tenantId, userId) =>
      read("list-passkeys", async () => {
        const rows = await sql<PasskeyRow[]>`
          SELECT tenant_id, user_id, credential_id, public_key, algorithm, counter, transports,
                 created_at
          FROM ${sql(tables.passkeys)}
          WHERE tenant_id = ${tenantId} AND user_id = ${userId}
          ORDER BY created_at, credential_id
        `;
        return rows.map(decodePasskey);
      }),
    updatePasskeyCounter: (tenantId, credentialId, expectedCounter, counter) =>
      read("update-passkey-counter", async () => {
        const rows = await sql<{ readonly credential_id: string }[]>`
          UPDATE ${sql(tables.passkeys)}
          SET counter = ${counter}
          WHERE tenant_id = ${tenantId} AND credential_id = ${credentialId}
            AND counter = ${expectedCounter}
          RETURNING credential_id
        `;
        return rows.length > 0;
      }).pipe(
        Effect.flatMap((updated) =>
          updated
            ? Effect.void
            : Effect.fail(new IdentityConflict({ tenantId, identity: "passkey-counter" })),
        ),
      ),
  };
};
