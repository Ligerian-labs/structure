import { DynamoDBDocumentService } from "@effect-aws/dynamodb";
import {
  type AuthStore,
  AuthStoreError,
  type AuthUser,
  IdentityConflict,
  type OAuthIdentity,
  type OAuthStateRecord,
  type OneTimeTokenRecord,
  type PasskeyChallengeRecord,
  type PasskeyRecord,
  type PasswordCredential,
  type SessionRecord,
  type TenantId,
  type UserId,
} from "@structure-ai/auth";
import { Effect, Option, Redacted } from "effect";

/**
 * `AuthStore` over the DynamoDB single table (ADR-0015). Every entity is an
 * item with prefixed keys; lookups that SQL would answer with unique
 * indexes are answered by **companion index items** written in the same
 * transaction as their primary (book ch. 16.1 — uniqueness via item
 * existence), and one-time tokens/states/challenges are consumed by a
 * `Delete` with `ReturnValues=ALL_OLD` — a single-item atomic consume.
 *
 * | Entity | pk | sk |
 * | --- | --- | --- |
 * | user | `A#<t>#U#<uid>` | `U` |
 * | email map (unique per tenant) | `A#<t>#E#<email>` | `E` → `{ uid }` |
 * | password credential | `A#<t>#E#<email>` | `P` |
 * | one-time token | `A#<t>#T#<purpose>#<hash>` | `T` |
 * | session | `A#<t>#S#<tokenHash>` | `S` |
 * | session user-index | `A#<t>#SU#<uid>` | `<tokenHash>` |
 * | oauth state | `A#<t>#O#<stateHash>` | `O` |
 * | oauth identity (unique) | `A#<t>#I#<provider>#<subject>` | `I` |
 * | passkey challenge | `A#<t>#C#<purpose>#<hash>` | `C` |
 * | passkey | `A#<t>#K#<credentialId>` | `K` |
 * | passkey user-index | `A#<t>#PU#<uid>` | `<credentialId>` |
 */

/** Options for {@link make}. */
export interface AuthDynamoOptions {
  readonly tableName: string;
}

type StoreEffect<A> = Effect.Effect<A, AuthStoreError | IdentityConflict>;

const PK = "pk";
const SK = "sk";

const userPk = (tenantId: TenantId, userId: UserId): string => `A#${tenantId}#U#${userId}`;
const userSk = "U";
const emailPk = (tenantId: TenantId, email: string): string => `A#${tenantId}#E#${email}`;
const emailSk = "E";
const passwordSk = "P";
const tokenPk = (tenantId: TenantId, purpose: string, tokenHash: string): string =>
  `A#${tenantId}#T#${purpose}#${tokenHash}`;
const tokenSk = "T";
const sessionPk = (tenantId: TenantId, tokenHash: string): string => `A#${tenantId}#S#${tokenHash}`;
const sessionSk = "S";
const sessionIndexPk = (tenantId: TenantId, userId: UserId): string => `A#${tenantId}#SU#${userId}`;
const oauthStatePk = (tenantId: TenantId, stateHash: string): string =>
  `A#${tenantId}#O#${stateHash}`;
const oauthStateSk = "O";
const oauthIdentityPk = (tenantId: TenantId, provider: string, subject: string): string =>
  `A#${tenantId}#I#${provider}#${subject}`;
const oauthIdentitySk = "I";
const challengePk = (tenantId: TenantId, purpose: string, challengeHash: string): string =>
  `A#${tenantId}#C#${purpose}#${challengeHash}`;
const challengeSk = "C";
const passkeyPk = (tenantId: TenantId, credentialId: string): string =>
  `A#${tenantId}#K#${credentialId}`;
const passkeySk = "K";
const passkeyIndexPk = (tenantId: TenantId, userId: UserId): string => `A#${tenantId}#PU#${userId}`;

const iso = (value: Date): string => value.toISOString();
const date = (value: unknown): Date => (typeof value === "string" ? new Date(value) : new Date(0));

const storeError = (operation: string, cause: unknown): AuthStoreError =>
  new AuthStoreError({ operation, cause });

const isConditionalFailure = (error: unknown): boolean => {
  const tag =
    (error as { readonly _tag?: string })._tag ?? (error as { readonly name?: string }).name;
  // Inside transactions, a failed condition surfaces as a cancellation.
  return tag === "ConditionalCheckFailedException" || tag === "TransactionCanceledException";
};

const decodeUser = (item: Record<string, unknown>): AuthUser => ({
  id: item.id as UserId,
  tenantId: item.tenantId as TenantId,
  ...(item.email !== undefined && { email: item.email as string }),
  emailVerified: item.emailVerified === true,
  ...(item.displayName !== undefined && { displayName: item.displayName as string }),
  createdAt: date(item.createdAt),
  updatedAt: date(item.updatedAt),
});

const userItem = (user: AuthUser): Record<string, unknown> => ({
  [PK]: userPk(user.tenantId, user.id),
  [SK]: userSk,
  entity: "auth-user",
  id: user.id,
  tenantId: user.tenantId,
  ...(user.email !== undefined && { email: user.email }),
  emailVerified: user.emailVerified,
  ...(user.displayName !== undefined && { displayName: user.displayName }),
  createdAt: iso(user.createdAt),
  updatedAt: iso(user.updatedAt),
});

const decodePassword = (item: Record<string, unknown>): PasswordCredential => ({
  tenantId: item.tenantId as TenantId,
  userId: item.userId as UserId,
  email: item.email as string,
  passwordHash: item.passwordHash as string,
  updatedAt: date(item.updatedAt),
});

const decodeToken = (item: Record<string, unknown>): OneTimeTokenRecord => ({
  tenantId: item.tenantId as TenantId,
  purpose: item.purpose as OneTimeTokenRecord["purpose"],
  tokenHash: item.tokenHash as string,
  email: item.email as string,
  ...(item.userId !== undefined && { userId: item.userId as UserId }),
  expiresAt: date(item.expiresAt),
});

const decodeSession = (item: Record<string, unknown>): SessionRecord => ({
  id: item.id as string,
  tenantId: item.tenantId as TenantId,
  userId: item.userId as UserId,
  tokenHash: item.tokenHash as string,
  createdAt: date(item.createdAt),
  expiresAt: date(item.expiresAt),
});

const decodeOAuthState = (item: Record<string, unknown>): OAuthStateRecord => ({
  tenantId: item.tenantId as TenantId,
  provider: item.provider as OAuthStateRecord["provider"],
  stateHash: item.stateHash as string,
  codeVerifier: Redacted.make(item.codeVerifier as string),
  redirectUri: item.redirectUri as string,
  ...(item.returnTo !== undefined && { returnTo: item.returnTo as string }),
  expiresAt: date(item.expiresAt),
});

const decodeOAuthIdentity = (item: Record<string, unknown>): OAuthIdentity => ({
  tenantId: item.tenantId as TenantId,
  userId: item.userId as UserId,
  provider: item.provider as OAuthIdentity["provider"],
  subject: item.subject as string,
  ...(item.email !== undefined && { email: item.email as string }),
  createdAt: date(item.createdAt),
});

const decodeChallenge = (item: Record<string, unknown>): PasskeyChallengeRecord => ({
  tenantId: item.tenantId as TenantId,
  purpose: item.purpose as PasskeyChallengeRecord["purpose"],
  challengeHash: item.challengeHash as string,
  ...(item.userId !== undefined && { userId: item.userId as UserId }),
  expiresAt: date(item.expiresAt),
});

const decodePasskey = (item: Record<string, unknown>): PasskeyRecord => ({
  tenantId: item.tenantId as TenantId,
  userId: item.userId as UserId,
  credentialId: item.credentialId as string,
  publicKey: item.publicKey as string,
  algorithm: item.algorithm as PasskeyRecord["algorithm"],
  counter: item.counter as number,
  transports: (item.transports ?? []) as ReadonlyArray<string>,
  createdAt: date(item.createdAt),
});

/** Builds the `AuthStore` over the shared table. */
export const make = (
  options: AuthDynamoOptions,
): Effect.Effect<AuthStore, never, DynamoDBDocumentService> =>
  Effect.map(DynamoDBDocumentService, (ddb) => {
    const table = options.tableName;

    const get = (pk: string, sk: string) =>
      ddb.get({ TableName: table, Key: { [PK]: pk, [SK]: sk }, ConsistentRead: true }).pipe(
        Effect.map((output) =>
          Option.fromNullable(output.Item as Record<string, unknown> | undefined),
        ),
        Effect.mapError((cause) => storeError("get", cause)),
      );

    const put = (item: Record<string, unknown>, operation: string, unique = false) =>
      ddb
        .put({
          TableName: table,
          Item: item,
          ...(unique && {
            ConditionExpression: "attribute_not_exists(#pk)",
            ExpressionAttributeNames: { "#pk": PK },
          }),
        })
        .pipe(
          Effect.asVoid,
          Effect.mapError((cause) => storeError(operation, cause)),
        );

    const deleteOld = (pk: string, sk: string, operation: string) =>
      ddb.delete({ TableName: table, Key: { [PK]: pk, [SK]: sk }, ReturnValues: "ALL_OLD" }).pipe(
        Effect.map((output) =>
          Option.fromNullable(output.Attributes as Record<string, unknown> | undefined),
        ),
        Effect.mapError((cause) => storeError(operation, cause)),
      );

    const transact = (
      items: ReadonlyArray<Record<string, unknown>>,
      operation: string,
      conflictsWith?: string,
    ) =>
      ddb
        .transactWrite({
          TransactItems: items.map((item) => ({
            Put: {
              TableName: table,
              Item: item,
              ConditionExpression: "attribute_not_exists(#pk)",
              ExpressionAttributeNames: { "#pk": PK },
            },
          })),
        })
        .pipe(
          Effect.asVoid,
          Effect.catchAll((error): Effect.Effect<never, AuthStoreError | IdentityConflict> => {
            if ((error as { readonly _tag?: string })._tag === "IdentityConflict") {
              return Effect.fail(error as unknown as IdentityConflict);
            }
            if (isConditionalFailure(error) && conflictsWith !== undefined) {
              return Effect.fail(
                new IdentityConflict({ tenantId: conflictsWith, identity: "email" }),
              );
            }
            return Effect.fail(storeError(operation, error));
          }),
        );

    return {
      createPasswordUser: (user, credential): StoreEffect<void> =>
        transact(
          [
            userItem(user),
            {
              [PK]: emailPk(user.tenantId, credential.email),
              [SK]: emailSk,
              entity: "auth-email",
              tenantId: user.tenantId,
              email: credential.email,
              uid: user.id,
            },
            {
              [PK]: emailPk(user.tenantId, credential.email),
              [SK]: passwordSk,
              entity: "auth-password",
              tenantId: credential.tenantId,
              userId: credential.userId,
              email: credential.email,
              passwordHash: credential.passwordHash,
              updatedAt: iso(credential.updatedAt),
            },
          ],
          "createPasswordUser",
          user.tenantId,
        ),
      createOAuthUser: (user, identity): StoreEffect<void> =>
        transact(
          [
            userItem(user),
            {
              [PK]: oauthIdentityPk(identity.tenantId, identity.provider, identity.subject),
              [SK]: oauthIdentitySk,
              entity: "auth-oauth-identity",
              tenantId: identity.tenantId,
              userId: identity.userId,
              provider: identity.provider,
              subject: identity.subject,
              ...(identity.email !== undefined && { email: identity.email }),
              createdAt: iso(identity.createdAt),
            },
            ...(user.email !== undefined
              ? [
                  {
                    [PK]: emailPk(user.tenantId, user.email),
                    [SK]: emailSk,
                    entity: "auth-email",
                    tenantId: user.tenantId,
                    email: user.email,
                    uid: user.id,
                  },
                ]
              : []),
          ],
          "createOAuthUser",
          user.tenantId,
        ),
      createMagicLinkUser: (user): StoreEffect<void> =>
        transact(
          [
            userItem(user),
            ...(user.email !== undefined
              ? [
                  {
                    [PK]: emailPk(user.tenantId, user.email),
                    [SK]: emailSk,
                    entity: "auth-email",
                    tenantId: user.tenantId,
                    email: user.email,
                    uid: user.id,
                  },
                ]
              : []),
          ],
          "createMagicLinkUser",
          user.tenantId,
        ),
      findUserById: (tenantId, userId): StoreEffect<AuthUser | undefined> =>
        Effect.map(get(userPk(tenantId, userId), userSk), (item) =>
          Option.isNone(item) ? undefined : decodeUser(item.value),
        ),
      findUserByEmail: (tenantId, email): StoreEffect<AuthUser | undefined> =>
        Effect.flatMap(get(emailPk(tenantId, email), emailSk), (map) =>
          Option.isNone(map)
            ? Effect.succeed(undefined)
            : Effect.map(get(userPk(tenantId, map.value.uid as UserId), userSk), (item) =>
                Option.isNone(item) ? undefined : decodeUser(item.value),
              ),
        ),
      findPassword: (tenantId, email): StoreEffect<PasswordCredential | undefined> =>
        Effect.map(get(emailPk(tenantId, email), passwordSk), (item) =>
          Option.isNone(item) ? undefined : decodePassword(item.value),
        ),
      setEmailVerified: (tenantId, userId, now): StoreEffect<AuthUser | undefined> =>
        ddb
          .update({
            TableName: table,
            Key: { [PK]: userPk(tenantId, userId), [SK]: userSk },
            UpdateExpression: "SET #verified = :true, #updatedAt = :now",
            ConditionExpression: "attribute_exists(#pk)",
            ExpressionAttributeNames: {
              "#verified": "emailVerified",
              "#updatedAt": "updatedAt",
              "#pk": PK,
            },
            ExpressionAttributeValues: { ":true": true, ":now": iso(now) },
            ReturnValues: "ALL_NEW",
          })
          .pipe(
            Effect.map((output) =>
              Option.isNone(Option.fromNullable(output.Attributes))
                ? undefined
                : decodeUser(output.Attributes as Record<string, unknown>),
            ),
            Effect.catchIf(isConditionalFailure, () => Effect.succeed(undefined)),
            Effect.mapError((cause) => storeError("setEmailVerified", cause)),
          ),
      replacePasswordAndRevokeSessions: (tenantId, userId, passwordHash, now): StoreEffect<void> =>
        Effect.gen(function* () {
          // Find the email via the user record, then replace the credential.
          const user = yield* Effect.flatMap(get(userPk(tenantId, userId), userSk), (item) =>
            Option.isNone(item)
              ? Effect.fail(storeError("replacePassword", "user not found"))
              : Effect.succeed(decodeUser(item.value)),
          );
          const email = user.email ?? "";
          yield* ddb
            .update({
              TableName: table,
              Key: { [PK]: emailPk(tenantId, email), [SK]: passwordSk },
              UpdateExpression: "SET #hash = :hash, #updatedAt = :now",
              ExpressionAttributeNames: { "#hash": "passwordHash", "#updatedAt": "updatedAt" },
              ExpressionAttributeValues: { ":hash": passwordHash, ":now": iso(now) },
            })
            .pipe(
              Effect.asVoid,
              Effect.mapError((cause) => storeError("replacePassword", cause)),
            );
          // Revoke every session of this user (tenant-scoped).
          const indexed = yield* ddb
            .query({
              TableName: table,
              KeyConditionExpression: "#pk = :pk",
              ConsistentRead: true,
              ExpressionAttributeNames: { "#pk": PK },
              ExpressionAttributeValues: { ":pk": sessionIndexPk(tenantId, userId) },
            })
            .pipe(Effect.mapError((cause) => storeError("revokeUserSessions", cause)));
          for (const item of indexed.Items ?? []) {
            const tokenHash = item[SK] as string;
            yield* ddb
              .transactWrite({
                TransactItems: [
                  {
                    Delete: {
                      TableName: table,
                      Key: { [PK]: sessionPk(tenantId, tokenHash), [SK]: sessionSk },
                    },
                  },
                  {
                    Delete: {
                      TableName: table,
                      Key: { [PK]: sessionIndexPk(tenantId, userId), [SK]: tokenHash },
                    },
                  },
                ],
              })
              .pipe(
                Effect.asVoid,
                Effect.mapError((cause) => storeError("revokeUserSessions", cause)),
              );
          }
        }),
      putOneTimeToken: (record): StoreEffect<void> =>
        Effect.gen(function* () {
          // Replaces the current token for (tenant, purpose, email): the
          // pointer item names the live hash, and the previous record item
          // is deleted in the same transaction (the in-memory spec deletes
          // the old token, so consuming it afterwards yields undefined).
          const pointerPk = `A#${record.tenantId}#TP#${record.purpose}#${record.email}`;
          const current = yield* get(pointerPk, tokenSk);
          const previousHash = Option.isNone(current) ? undefined : (current.value.hash as string);
          yield* ddb
            .transactWrite({
              TransactItems: [
                {
                  Put: {
                    TableName: table,
                    Item: {
                      [PK]: tokenPk(record.tenantId, record.purpose, record.tokenHash),
                      [SK]: tokenSk,
                      entity: "auth-token",
                      tenantId: record.tenantId,
                      purpose: record.purpose,
                      tokenHash: record.tokenHash,
                      email: record.email,
                      ...(record.userId !== undefined && { userId: record.userId }),
                      expiresAt: iso(record.expiresAt),
                    },
                  },
                },
                {
                  Put: {
                    TableName: table,
                    Item: {
                      [PK]: pointerPk,
                      [SK]: tokenSk,
                      entity: "auth-token-pointer",
                      tenantId: record.tenantId,
                      purpose: record.purpose,
                      email: record.email,
                      hash: record.tokenHash,
                    },
                  },
                },
                ...(previousHash !== undefined && previousHash !== record.tokenHash
                  ? [
                      {
                        Delete: {
                          TableName: table,
                          Key: {
                            [PK]: tokenPk(record.tenantId, record.purpose, previousHash),
                            [SK]: tokenSk,
                          },
                        },
                      },
                    ]
                  : []),
              ],
            })
            .pipe(
              Effect.asVoid,
              Effect.mapError((cause) => storeError("putOneTimeToken", cause)),
            );
        }),
      consumeOneTimeToken: (
        tenantId,
        purpose,
        tokenHash,
        now,
      ): StoreEffect<OneTimeTokenRecord | undefined> =>
        Effect.map(
          deleteOld(tokenPk(tenantId, purpose, tokenHash), tokenSk, "consumeOneTimeToken"),
          (item) => {
            if (Option.isNone(item)) return undefined;
            const record = decodeToken(item.value);
            return record.expiresAt > now ? record : undefined;
          },
        ),
      createSession: (record): StoreEffect<void> =>
        transact(
          [
            {
              [PK]: sessionPk(record.tenantId, record.tokenHash),
              [SK]: sessionSk,
              entity: "auth-session",
              id: record.id,
              tenantId: record.tenantId,
              userId: record.userId,
              tokenHash: record.tokenHash,
              createdAt: iso(record.createdAt),
              expiresAt: iso(record.expiresAt),
            },
            {
              [PK]: sessionIndexPk(record.tenantId, record.userId),
              [SK]: record.tokenHash,
              entity: "auth-session-index",
              tenantId: record.tenantId,
              userId: record.userId,
            },
          ],
          "createSession",
        ),
      findSession: (tenantId, tokenHash, now): StoreEffect<SessionRecord | undefined> =>
        Effect.map(get(sessionPk(tenantId, tokenHash), sessionSk), (item) => {
          if (Option.isNone(item)) return undefined;
          const record = decodeSession(item.value);
          return record.expiresAt > now ? record : undefined;
        }),
      revokeSession: (tenantId, tokenHash): StoreEffect<void> =>
        Effect.flatMap(get(sessionPk(tenantId, tokenHash), sessionSk), (item) =>
          Option.isNone(item)
            ? Effect.void
            : ddb
                .transactWrite({
                  TransactItems: [
                    {
                      Delete: {
                        TableName: table,
                        Key: { [PK]: sessionPk(tenantId, tokenHash), [SK]: sessionSk },
                      },
                    },
                    {
                      Delete: {
                        TableName: table,
                        Key: {
                          [PK]: sessionIndexPk(tenantId, item.value.userId as UserId),
                          [SK]: tokenHash,
                        },
                      },
                    },
                  ],
                })
                .pipe(
                  Effect.asVoid,
                  Effect.mapError((cause) => storeError("revokeSession", cause)),
                ),
        ),
      revokeUserSessions: (tenantId, userId): StoreEffect<void> =>
        Effect.gen(function* () {
          const indexed = yield* ddb
            .query({
              TableName: table,
              KeyConditionExpression: "#pk = :pk",
              ConsistentRead: true,
              ExpressionAttributeNames: { "#pk": PK },
              ExpressionAttributeValues: { ":pk": sessionIndexPk(tenantId, userId) },
            })
            .pipe(Effect.mapError((cause) => storeError("revokeUserSessions", cause)));
          for (const item of indexed.Items ?? []) {
            const tokenHash = item[SK] as string;
            yield* ddb
              .transactWrite({
                TransactItems: [
                  {
                    Delete: {
                      TableName: table,
                      Key: { [PK]: sessionPk(tenantId, tokenHash), [SK]: sessionSk },
                    },
                  },
                  {
                    Delete: {
                      TableName: table,
                      Key: { [PK]: sessionIndexPk(tenantId, userId), [SK]: tokenHash },
                    },
                  },
                ],
              })
              .pipe(
                Effect.asVoid,
                Effect.mapError((cause) => storeError("revokeUserSessions", cause)),
              );
          }
        }),
      putOAuthState: (record): StoreEffect<void> =>
        put(
          {
            [PK]: oauthStatePk(record.tenantId, record.stateHash),
            [SK]: oauthStateSk,
            entity: "auth-oauth-state",
            tenantId: record.tenantId,
            provider: record.provider,
            stateHash: record.stateHash,
            codeVerifier: Redacted.value(record.codeVerifier),
            redirectUri: record.redirectUri,
            ...(record.returnTo !== undefined && { returnTo: record.returnTo }),
            expiresAt: iso(record.expiresAt),
          },
          "putOAuthState",
        ),
      consumeOAuthState: (tenantId, stateHash, now): StoreEffect<OAuthStateRecord | undefined> =>
        Effect.map(
          deleteOld(oauthStatePk(tenantId, stateHash), oauthStateSk, "consumeOAuthState"),
          (item) => {
            if (Option.isNone(item)) return undefined;
            const record = decodeOAuthState(item.value);
            return record.expiresAt > now ? record : undefined;
          },
        ),
      findOAuthIdentity: (tenantId, provider, subject): StoreEffect<OAuthIdentity | undefined> =>
        Effect.map(get(oauthIdentityPk(tenantId, provider, subject), oauthIdentitySk), (item) =>
          Option.isNone(item) ? undefined : decodeOAuthIdentity(item.value),
        ),
      addOAuthIdentity: (identity): StoreEffect<void> =>
        put(
          {
            [PK]: oauthIdentityPk(identity.tenantId, identity.provider, identity.subject),
            [SK]: oauthIdentitySk,
            entity: "auth-oauth-identity",
            tenantId: identity.tenantId,
            userId: identity.userId,
            provider: identity.provider,
            subject: identity.subject,
            ...(identity.email !== undefined && { email: identity.email }),
            createdAt: iso(identity.createdAt),
          },
          "addOAuthIdentity",
          true,
        ).pipe(
          Effect.catchAll((error): Effect.Effect<never, AuthStoreError | IdentityConflict> => {
            if (error._tag === "AuthStoreError" && isConditionalFailure(error.cause)) {
              return Effect.fail(
                new IdentityConflict({
                  tenantId: identity.tenantId,
                  identity: `${identity.provider}:${identity.subject}`,
                }),
              );
            }
            return Effect.fail(error);
          }),
        ),
      putPasskeyChallenge: (record): StoreEffect<void> =>
        put(
          {
            [PK]: challengePk(record.tenantId, record.purpose, record.challengeHash),
            [SK]: challengeSk,
            entity: "auth-passkey-challenge",
            tenantId: record.tenantId,
            purpose: record.purpose,
            challengeHash: record.challengeHash,
            ...(record.userId !== undefined && { userId: record.userId }),
            expiresAt: iso(record.expiresAt),
          },
          "putPasskeyChallenge",
        ),
      consumePasskeyChallenge: (
        tenantId,
        purpose,
        challengeHash,
        now,
      ): StoreEffect<PasskeyChallengeRecord | undefined> =>
        Effect.map(
          deleteOld(
            challengePk(tenantId, purpose, challengeHash),
            challengeSk,
            "consumePasskeyChallenge",
          ),
          (item) => {
            if (Option.isNone(item)) return undefined;
            const record = decodeChallenge(item.value);
            return record.expiresAt > now ? record : undefined;
          },
        ),
      addPasskey: (record): StoreEffect<void> =>
        transact(
          [
            {
              [PK]: passkeyPk(record.tenantId, record.credentialId),
              [SK]: passkeySk,
              entity: "auth-passkey",
              tenantId: record.tenantId,
              userId: record.userId,
              credentialId: record.credentialId,
              publicKey: record.publicKey,
              algorithm: record.algorithm,
              counter: record.counter,
              transports: [...record.transports],
              createdAt: iso(record.createdAt),
            },
            {
              [PK]: passkeyIndexPk(record.tenantId, record.userId),
              [SK]: record.credentialId,
              entity: "auth-passkey-index",
              tenantId: record.tenantId,
              userId: record.userId,
            },
          ],
          "addPasskey",
        ),
      findPasskey: (tenantId, credentialId): StoreEffect<PasskeyRecord | undefined> =>
        Effect.map(get(passkeyPk(tenantId, credentialId), passkeySk), (item) =>
          Option.isNone(item) ? undefined : decodePasskey(item.value),
        ),
      listPasskeys: (tenantId, userId): StoreEffect<ReadonlyArray<PasskeyRecord>> =>
        Effect.flatMap(
          ddb
            .query({
              TableName: table,
              KeyConditionExpression: "#pk = :pk",
              ConsistentRead: true,
              ExpressionAttributeNames: { "#pk": PK },
              ExpressionAttributeValues: { ":pk": passkeyIndexPk(tenantId, userId) },
            })
            .pipe(Effect.mapError((cause) => storeError("listPasskeys", cause))),
          (output) =>
            Effect.forEach(output.Items ?? [], (item) =>
              Effect.map(get(passkeyPk(tenantId, item[SK] as string), passkeySk), (found) =>
                Option.isNone(found) ? undefined : decodePasskey(found.value),
              ),
            ).pipe(
              Effect.map((passkeys) =>
                passkeys.filter((passkey): passkey is PasskeyRecord => passkey !== undefined),
              ),
            ),
        ),
      updatePasskeyCounter: (tenantId, credentialId, expectedCounter, counter): StoreEffect<void> =>
        ddb
          .update({
            TableName: table,
            Key: { [PK]: passkeyPk(tenantId, credentialId), [SK]: passkeySk },
            UpdateExpression: "SET #counter = :counter",
            ConditionExpression: "#counter = :expected",
            ExpressionAttributeNames: { "#counter": "counter" },
            ExpressionAttributeValues: { ":counter": counter, ":expected": expectedCounter },
          })
          .pipe(
            Effect.asVoid,
            Effect.catchAll((error): Effect.Effect<never, AuthStoreError | IdentityConflict> => {
              if ((error as { readonly _tag?: string })._tag === "IdentityConflict") {
                return Effect.fail(error as unknown as IdentityConflict);
              }
              if (isConditionalFailure(error)) {
                return Effect.fail(
                  new IdentityConflict({ tenantId, identity: `passkey:${credentialId}` }),
                );
              }
              return Effect.fail(storeError("updatePasskeyCounter", error));
            }),
          ),
    } satisfies AuthStore;
  });
