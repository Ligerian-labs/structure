import {
  type AuthorizationCodeRecord,
  AuthStoreError,
  type ConsentRecord,
  type EndSessionHintRecord,
  type OAuthClientRecord,
  type OAuthServerStore,
  type OAuthTokenRecord,
} from "@structure-ai/auth";
import type { SQL } from "bun";
import { Effect } from "effect";
import { type AdapterOptions, tableNames } from "./schema.js";

type DateValue = Date | string;
const date = (value: DateValue): Date => (value instanceof Date ? value : new Date(value));
const decodeList = (value: string): ReadonlyArray<string> => {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string") ? parsed : [];
};

interface ClientRow {
  readonly tenant_id: string;
  readonly client_id: string;
  readonly client_name: string | null;
  readonly client_type: "confidential" | "public";
  readonly secret_hash: string | null;
  readonly redirect_uris: string;
  readonly scopes: string;
  readonly created_at: DateValue;
}

interface CodeRow {
  readonly tenant_id: string;
  readonly code_hash: string;
  readonly client_id: string;
  readonly user_id: string;
  readonly redirect_uri: string;
  readonly scope: string;
  readonly code_challenge: string;
  readonly expires_at: DateValue;
  readonly consumed_at: DateValue | null;
}

interface TokenRow {
  readonly tenant_id: string;
  readonly token_id: string;
  readonly kind: "access" | "refresh";
  readonly client_id: string;
  readonly user_id: string | null;
  readonly scope: string;
  readonly token_hash: string | null;
  readonly family_id: string | null;
  readonly expires_at: DateValue;
  readonly revoked_at: DateValue | null;
  readonly created_at: DateValue;
}

interface ConsentRow {
  readonly tenant_id: string;
  readonly client_id: string;
  readonly user_id: string;
  readonly scope: string;
  readonly granted_at: DateValue;
}

interface HintRow {
  readonly tenant_id: string;
  readonly hint_hash: string;
  readonly expires_at: DateValue;
  readonly consumed_at: DateValue | null;
}

const decodeClient = (row: ClientRow): OAuthClientRecord => ({
  tenantId: row.tenant_id,
  clientId: row.client_id,
  ...(row.client_name === null ? {} : { clientName: row.client_name }),
  clientType: row.client_type,
  ...(row.secret_hash === null ? {} : { secretHash: row.secret_hash }),
  redirectUris: decodeList(row.redirect_uris),
  scopes: decodeList(row.scopes),
  createdAt: date(row.created_at),
});

const decodeCode = (row: CodeRow): AuthorizationCodeRecord => ({
  tenantId: row.tenant_id,
  codeHash: row.code_hash,
  clientId: row.client_id,
  userId: row.user_id,
  redirectUri: row.redirect_uri,
  scope: decodeList(row.scope),
  codeChallenge: row.code_challenge,
  expiresAt: date(row.expires_at),
  ...(row.consumed_at === null ? {} : { consumedAt: date(row.consumed_at) }),
});

const decodeToken = (row: TokenRow): OAuthTokenRecord => ({
  tenantId: row.tenant_id,
  tokenId: row.token_id,
  kind: row.kind,
  clientId: row.client_id,
  ...(row.user_id === null ? {} : { userId: row.user_id }),
  scope: decodeList(row.scope),
  ...(row.token_hash === null ? {} : { tokenHash: row.token_hash }),
  ...(row.family_id === null ? {} : { familyId: row.family_id }),
  expiresAt: date(row.expires_at),
  ...(row.revoked_at === null ? {} : { revokedAt: date(row.revoked_at) }),
  createdAt: date(row.created_at),
});

const decodeConsent = (row: ConsentRow): ConsentRecord => ({
  tenantId: row.tenant_id,
  clientId: row.client_id,
  userId: row.user_id,
  scope: decodeList(row.scope),
  grantedAt: date(row.granted_at),
});

const decodeHint = (row: HintRow): EndSessionHintRecord => ({
  tenantId: row.tenant_id,
  hintHash: row.hint_hash,
  expiresAt: date(row.expires_at),
  ...(row.consumed_at === null ? {} : { consumedAt: date(row.consumed_at) }),
});

/** Builds an `OAuthServerStore` over an already-migrated Bun SQL connection. */
export const makeOAuthServerStore = (sql: SQL, options: AdapterOptions = {}): OAuthServerStore => {
  const tables = tableNames(options);
  const read = <A>(operation: string, query: () => Promise<A>): Effect.Effect<A, AuthStoreError> =>
    Effect.tryPromise({
      try: query,
      catch: (cause) => new AuthStoreError({ operation, cause }),
    });

  return {
    putClient: (record) =>
      read("oauth-put-client", async () => {
        await sql`
          INSERT INTO ${sql(tables.oauthClients)}
            (tenant_id, client_id, client_name, client_type, secret_hash, redirect_uris, scopes, created_at)
          VALUES
            (${record.tenantId}, ${record.clientId}, ${record.clientName ?? null},
             ${record.clientType}, ${record.secretHash ?? null},
             ${JSON.stringify(record.redirectUris)}, ${JSON.stringify(record.scopes)},
             ${record.createdAt.toISOString()})
          ON CONFLICT (tenant_id, client_id) DO UPDATE SET
            client_name = excluded.client_name,
            client_type = excluded.client_type,
            secret_hash = excluded.secret_hash,
            redirect_uris = excluded.redirect_uris,
            scopes = excluded.scopes
        `;
      }).pipe(Effect.asVoid),
    findClient: (tenantId, clientId) =>
      read("oauth-find-client", async () => {
        const rows = await sql<ClientRow[]>`
          SELECT tenant_id, client_id, client_name, client_type, secret_hash, redirect_uris,
                 scopes, created_at
          FROM ${sql(tables.oauthClients)}
          WHERE tenant_id = ${tenantId} AND client_id = ${clientId}
        `;
        return rows[0] === undefined ? undefined : decodeClient(rows[0]);
      }),
    putAuthorizationCode: (record) =>
      read("oauth-put-code", async () => {
        await sql`
          INSERT INTO ${sql(tables.oauthCodes)}
            (tenant_id, code_hash, client_id, user_id, redirect_uri, scope, code_challenge,
             expires_at, consumed_at)
          VALUES
            (${record.tenantId}, ${record.codeHash}, ${record.clientId}, ${record.userId},
             ${record.redirectUri}, ${JSON.stringify(record.scope)}, ${record.codeChallenge},
             ${record.expiresAt.toISOString()}, ${record.consumedAt?.toISOString() ?? null})
        `;
      }).pipe(Effect.asVoid),
    consumeAuthorizationCode: (tenantId, codeHash, at) =>
      read("oauth-consume-code", async () => {
        const rows = await sql<CodeRow[]>`
          UPDATE ${sql(tables.oauthCodes)}
          SET consumed_at = ${at.toISOString()}
          WHERE tenant_id = ${tenantId} AND code_hash = ${codeHash}
            AND consumed_at IS NULL AND expires_at > ${at.toISOString()}
          RETURNING tenant_id, code_hash, client_id, user_id, redirect_uri, scope,
                    code_challenge, expires_at, consumed_at
        `;
        return rows[0] === undefined ? undefined : decodeCode(rows[0]);
      }),
    findConsent: (tenantId, clientId, userId) =>
      read("oauth-find-consent", async () => {
        const rows = await sql<ConsentRow[]>`
          SELECT tenant_id, client_id, user_id, scope, granted_at
          FROM ${sql(tables.oauthConsents)}
          WHERE tenant_id = ${tenantId} AND client_id = ${clientId} AND user_id = ${userId}
        `;
        return rows[0] === undefined ? undefined : decodeConsent(rows[0]);
      }),
    putConsent: (record) =>
      read("oauth-put-consent", async () => {
        await sql`
          INSERT INTO ${sql(tables.oauthConsents)}
            (tenant_id, client_id, user_id, scope, granted_at)
          VALUES
            (${record.tenantId}, ${record.clientId}, ${record.userId},
             ${JSON.stringify(record.scope)}, ${record.grantedAt.toISOString()})
          ON CONFLICT (tenant_id, client_id, user_id) DO UPDATE SET
            scope = excluded.scope,
            granted_at = excluded.granted_at
        `;
      }).pipe(Effect.asVoid),
    putToken: (record) =>
      read("oauth-put-token", async () => {
        await sql`
          INSERT INTO ${sql(tables.oauthTokens)}
            (tenant_id, token_id, kind, client_id, user_id, scope, token_hash, family_id,
             expires_at, revoked_at, created_at)
          VALUES
            (${record.tenantId}, ${record.tokenId}, ${record.kind}, ${record.clientId},
             ${record.userId ?? null}, ${JSON.stringify(record.scope)},
             ${record.tokenHash ?? null}, ${record.familyId ?? null},
             ${record.expiresAt.toISOString()}, ${record.revokedAt?.toISOString() ?? null},
             ${record.createdAt.toISOString()})
        `;
      }).pipe(Effect.asVoid),
    findTokenByHash: (tenantId, tokenHash) =>
      read("oauth-find-token-by-hash", async () => {
        const rows = await sql<TokenRow[]>`
          SELECT tenant_id, token_id, kind, client_id, user_id, scope, token_hash, family_id,
                 expires_at, revoked_at, created_at
          FROM ${sql(tables.oauthTokens)}
          WHERE tenant_id = ${tenantId} AND token_hash = ${tokenHash}
        `;
        return rows[0] === undefined ? undefined : decodeToken(rows[0]);
      }),
    findTokenById: (tenantId, tokenId) =>
      read("oauth-find-token-by-id", async () => {
        const rows = await sql<TokenRow[]>`
          SELECT tenant_id, token_id, kind, client_id, user_id, scope, token_hash, family_id,
                 expires_at, revoked_at, created_at
          FROM ${sql(tables.oauthTokens)}
          WHERE tenant_id = ${tenantId} AND token_id = ${tokenId}
        `;
        return rows[0] === undefined ? undefined : decodeToken(rows[0]);
      }),
    revokeToken: (tenantId, tokenId, at) =>
      read("oauth-revoke-token", async () => {
        await sql`
          UPDATE ${sql(tables.oauthTokens)}
          SET revoked_at = ${at.toISOString()}
          WHERE tenant_id = ${tenantId} AND token_id = ${tokenId}
        `;
      }).pipe(Effect.asVoid),
    revokeFamily: (tenantId, familyId, at) =>
      read("oauth-revoke-family", async () => {
        await sql`
          UPDATE ${sql(tables.oauthTokens)}
          SET revoked_at = ${at.toISOString()}
          WHERE tenant_id = ${tenantId} AND family_id = ${familyId} AND revoked_at IS NULL
        `;
      }).pipe(Effect.asVoid),
    putEndSessionHint: (record) =>
      read("oauth-put-hint", async () => {
        await sql`
          INSERT INTO ${sql(tables.oauthEndSessionHints)}
            (tenant_id, hint_hash, expires_at, consumed_at)
          VALUES
            (${record.tenantId}, ${record.hintHash}, ${record.expiresAt.toISOString()},
             ${record.consumedAt?.toISOString() ?? null})
        `;
      }).pipe(Effect.asVoid),
    consumeEndSessionHint: (tenantId, hintHash, at) =>
      read("oauth-consume-hint", async () => {
        const rows = await sql<HintRow[]>`
          UPDATE ${sql(tables.oauthEndSessionHints)}
          SET consumed_at = ${at.toISOString()}
          WHERE tenant_id = ${tenantId} AND hint_hash = ${hintHash}
            AND consumed_at IS NULL AND expires_at > ${at.toISOString()}
          RETURNING tenant_id, hint_hash, expires_at, consumed_at
        `;
        return rows[0] === undefined ? undefined : decodeHint(rows[0]);
      }),
  };
};
