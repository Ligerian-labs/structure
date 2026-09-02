import { type ApiKeyRecord, type ApiKeyStore, AuthStoreError } from "@structure-ai/auth";
import type { SQL } from "bun";
import { Effect } from "effect";
import { type AdapterOptions, tableNames } from "./schema.js";

interface ApiKeyRow {
  readonly tenant_id: string;
  readonly key_id: string;
  readonly user_id: string;
  readonly name: string | null;
  readonly scopes: string;
  readonly secret_hash: string;
  readonly pepper_version: number;
  readonly workspace_id: string | null;
  readonly expires_at: string | null;
  readonly created_at: string;
  readonly last_used_at: string | null;
  readonly revoked_at: string | null;
}

type DateValue = Date | string;

const date = (value: DateValue): Date => (value instanceof Date ? value : new Date(value));

const decode = (row: ApiKeyRow): ApiKeyRecord => ({
  tenantId: row.tenant_id,
  keyId: row.key_id,
  userId: row.user_id,
  ...(row.name === null ? {} : { name: row.name }),
  scopes: JSON.parse(row.scopes) as ReadonlyArray<string>,
  secretHash: row.secret_hash,
  pepperVersion: Number(row.pepper_version),
  ...(row.workspace_id === null ? {} : { workspaceId: row.workspace_id }),
  ...(row.expires_at === null ? {} : { expiresAt: date(row.expires_at) }),
  createdAt: date(row.created_at),
  ...(row.last_used_at === null ? {} : { lastUsedAt: date(row.last_used_at) }),
  ...(row.revoked_at === null ? {} : { revokedAt: date(row.revoked_at) }),
});

const encodeScopes = (scopes: ReadonlyArray<string>): string => JSON.stringify(scopes);

/** Builds an `ApiKeyStore` over an already-migrated Bun SQL connection. */
export const makeApiKeyStore = (sql: SQL, options: AdapterOptions = {}): ApiKeyStore => {
  const tables = tableNames(options);

  const read = <A>(operation: string, query: () => Promise<A>): Effect.Effect<A, AuthStoreError> =>
    Effect.tryPromise({
      try: query,
      catch: (cause) => new AuthStoreError({ operation, cause }),
    });

  return {
    create: (record) =>
      read("api-key-create", async () => {
        await sql`
          INSERT INTO ${sql(tables.apiKeys)}
            (tenant_id, key_id, user_id, name, scopes, secret_hash, pepper_version,
             workspace_id, expires_at, created_at, last_used_at, revoked_at)
          VALUES
            (${record.tenantId}, ${record.keyId}, ${record.userId}, ${record.name ?? null},
             ${encodeScopes(record.scopes)}, ${record.secretHash}, ${record.pepperVersion},
             ${record.workspaceId ?? null}, ${record.expiresAt?.toISOString() ?? null},
             ${record.createdAt.toISOString()}, null, null)
        `;
      }).pipe(Effect.asVoid),
    findByKeyId: (tenantId, keyId) =>
      read("api-key-find", async () => {
        const rows = await sql<ApiKeyRow[]>`
          SELECT tenant_id, key_id, user_id, name, scopes, secret_hash, pepper_version,
                 workspace_id, expires_at, created_at, last_used_at, revoked_at
          FROM ${sql(tables.apiKeys)}
          WHERE tenant_id = ${tenantId} AND key_id = ${keyId}
        `;
        return rows[0] === undefined ? undefined : decode(rows[0]);
      }),
    markUsed: (tenantId, keyId, now) =>
      read("api-key-mark-used", async () => {
        await sql`
          UPDATE ${sql(tables.apiKeys)}
          SET last_used_at = ${now.toISOString()}
          WHERE tenant_id = ${tenantId} AND key_id = ${keyId}
        `;
      }).pipe(Effect.asVoid),
    replaceHash: (tenantId, keyId, secretHash, pepperVersion) =>
      read("api-key-replace-hash", async () => {
        await sql`
          UPDATE ${sql(tables.apiKeys)}
          SET secret_hash = ${secretHash}, pepper_version = ${pepperVersion}
          WHERE tenant_id = ${tenantId} AND key_id = ${keyId}
        `;
      }).pipe(Effect.asVoid),
    revoke: (tenantId, keyId, now) =>
      read("api-key-revoke", async () => {
        await sql`
          UPDATE ${sql(tables.apiKeys)}
          SET revoked_at = ${now.toISOString()}
          WHERE tenant_id = ${tenantId} AND key_id = ${keyId}
        `;
      }).pipe(Effect.asVoid),
    listByUser: (tenantId, userId) =>
      read("api-key-list", async () => {
        const rows = await sql<ApiKeyRow[]>`
          SELECT tenant_id, key_id, user_id, name, scopes, secret_hash, pepper_version,
                 workspace_id, expires_at, created_at, last_used_at, revoked_at
          FROM ${sql(tables.apiKeys)}
          WHERE tenant_id = ${tenantId} AND user_id = ${userId}
          ORDER BY created_at, key_id
        `;
        return rows.map(decode);
      }),
  };
};
