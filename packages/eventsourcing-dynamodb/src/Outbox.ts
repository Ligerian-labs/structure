import { DynamoDBDocumentService } from "@effect-aws/dynamodb";
import { PersistenceError } from "@structure-ai/domain";
import {
  Inbox,
  Outbox,
  type OutboxClaim,
  type OutboxEntry,
  type OutboxStatus,
} from "@structure-ai/eventsourcing";
import { Clock, Duration, Effect, Layer, Option } from "effect";
import { isHeadConflict } from "./internal.js";
import {
  type AdapterOptions,
  ENTITY,
  inboxPk,
  outboxItem,
  outboxPk,
  outboxSk,
  PK,
  SK,
  STATUS_KEY,
  tableName,
} from "./schema.js";

/** Retention for inbox dedupe keys before TTL reclaims them. */
const inboxRetentionSeconds = 60 * 60 * 24 * 7;

/** Claim bookkeeping lives on the item: `ct` token, `lu` lease-until (epoch ms). */
interface OutboxItem {
  readonly pk: string;
  readonly sk: string;
  readonly entity: "outbox";
  readonly g2?: string;
  readonly enq?: string;
  readonly topic: string;
  readonly p: unknown;
  readonly m: Readonly<Record<string, unknown>>;
  readonly status: string;
  readonly attempts: number;
  readonly lastError?: string;
  /** First-delivery or retry schedule (epoch ms); absent means due now. */
  readonly avail?: number;
  /** The claim token owning the entry, while a lease is live. */
  readonly ct?: string;
  /** When the owning lease lapses (epoch ms). */
  readonly lu?: number;
}

const decodeEntry = (item: OutboxItem): OutboxEntry => {
  const entry: OutboxEntry = {
    message: { id: item.pk.slice(2), topic: item.topic, payload: item.p, metadata: item.m },
    status: item.status as OutboxStatus,
    attempts: item.attempts,
  };
  const withError = item.lastError === undefined ? entry : { ...entry, lastError: item.lastError };
  return item.avail === undefined ? withError : { ...withError, availableAt: item.avail };
};

const persist =
  (operation: string) =>
  (cause: unknown): PersistenceError =>
    new PersistenceError({ operation, cause });

/** Whether a conditional update lost its race (entry claimed/settled elsewhere). */
const lostRace = (error: unknown): boolean => isHeadConflict(error);

/**
 * `Outbox` staging messages as items in the single table. `enqueue` is
 * idempotent per message id (`attribute_not_exists` condition); enqueue
 * order is the ULID `enq` attribute through the sparse `status` GSI, which
 * carries only non-terminal entries — published messages vanish from the
 * index when the attribute is removed (book ch. 13.4, sparse indexes).
 *
 * Delivery ownership is claim-based: `claim` takes a lease on up to
 * `limit` due, unclaimed entries with a conditional write per item
 * (`SET ct = :token, lu = :until WHERE … no live claim`), so concurrent
 * relays never share an entry. Settlements are fenced by the token: a
 * settlement whose token no longer matches the item's live claim changes
 * nothing and answers `false`.
 */
export const outboxLayer = (
  options?: AdapterOptions,
): Layer.Layer<Outbox, never, DynamoDBDocumentService> =>
  Layer.effect(
    Outbox,
    Effect.gen(function* () {
      const ddb = yield* DynamoDBDocumentService;
      const table = tableName(options);

      const queryByStatus = (
        status: "pending" | "dead",
        limit?: number,
      ): Effect.Effect<ReadonlyArray<OutboxEntry>, PersistenceError> =>
        ddb
          .query({
            TableName: table,
            IndexName: "status",
            KeyConditionExpression: "#g2 = :status",
            ExpressionAttributeNames: { "#g2": STATUS_KEY },
            ExpressionAttributeValues: { ":status": status },
            ...(limit !== undefined && { Limit: limit }),
          })
          .pipe(
            Effect.map((output) =>
              (output.Items ?? []).map((item) => decodeEntry(item as OutboxItem)),
            ),
            Effect.mapError(persist("outbox.query")),
          );

      /** Due now, with no live claim (a lapsed lease is claimable again). */
      const claimable = (item: OutboxItem, now: number): boolean => {
        if (item.status !== "pending") return false;
        if (item.avail !== undefined && item.avail > now) return false;
        return item.ct === undefined || item.lu === undefined || item.lu <= now;
      };

      const dueEntries = (
        limit: number,
      ): Effect.Effect<ReadonlyArray<OutboxItem>, PersistenceError> =>
        Effect.flatMap(Clock.currentTimeMillis, (now) =>
          Effect.map(
            ddb
              .query({
                TableName: table,
                IndexName: "status",
                KeyConditionExpression: "#g2 = :status",
                ExpressionAttributeNames: { "#g2": STATUS_KEY },
                ExpressionAttributeValues: { ":status": "pending" },
              })
              .pipe(Effect.mapError(persist("outbox.pending"))),
            (output) =>
              (output.Items ?? [])
                .map((item) => item as OutboxItem)
                .filter((item) => claimable(item, now))
                .slice(0, limit),
          ),
        );

      /**
       * One conditional settlement. The status guard keeps terminal entries
       * settled; the token guard fences out foreign or recovered claims.
       * Returns whether the write applied.
       */
      const settle = (
        messageId: string,
        updateExpression: string,
        values: Record<string, unknown>,
        names: Record<string, string>,
        claim: string | undefined,
        operation: string,
      ): Effect.Effect<boolean, PersistenceError> =>
        ddb
          .update({
            TableName: table,
            Key: { [PK]: outboxPk(messageId), [SK]: outboxSk },
            UpdateExpression: updateExpression,
            ConditionExpression:
              claim === undefined ? "#status = :pending" : "#status = :pending AND #ct = :claim",
            ExpressionAttributeNames:
              claim === undefined
                ? { ...names, "#status": "status" }
                : { ...names, "#status": "status", "#ct": "ct" },
            ExpressionAttributeValues:
              claim === undefined ? values : { ...values, ":claim": claim },
          })
          .pipe(
            Effect.as(true),
            Effect.catchIf(
              lostRace,
              (): Effect.Effect<boolean, PersistenceError> => Effect.succeed(false),
            ),
            Effect.mapError(persist(operation)),
          );

      return Outbox.of({
        enqueue: (messages) =>
          Effect.forEach(
            messages,
            (message) =>
              ddb
                .put({
                  TableName: table,
                  Item: outboxItem(message),
                  ConditionExpression: "attribute_not_exists(#pk)",
                  ExpressionAttributeNames: { "#pk": PK },
                })
                // Idempotent per id: an existing message is ignored.
                .pipe(
                  Effect.catchIf(
                    (error) =>
                      (error as { readonly _tag?: string })._tag ===
                      "ConditionalCheckFailedException",
                    () => Effect.void,
                  ),
                  Effect.mapError(persist("outbox.enqueue")),
                ),
            { discard: true },
          ),
        pending: (limit) =>
          Effect.flatMap(dueEntries(limit), (items) =>
            Effect.succeed(items.map((item) => decodeEntry(item))),
          ),
        claim: (limit, lease) =>
          Effect.flatMap(Clock.currentTimeMillis, (now) =>
            Effect.gen(function* () {
              const leaseUntil = now + Duration.toMillis(lease);
              const token = crypto.randomUUID();
              const candidates = yield* dueEntries(limit);
              const claimed: Array<OutboxEntry> = [];
              for (const item of candidates) {
                // The conditional write is the claim race: only one relay's
                // token lands; the losers' writes fail their condition.
                const taken = yield* ddb
                  .update({
                    TableName: table,
                    Key: { [PK]: item.pk, [SK]: outboxSk },
                    UpdateExpression: "SET #ct = :token, #lu = :until",
                    ConditionExpression:
                      "#status = :pending AND (attribute_not_exists(#ct) OR attribute_not_exists(#lu) OR #lu <= :now)",
                    ExpressionAttributeNames: {
                      "#status": "status",
                      "#ct": "ct",
                      "#lu": "lu",
                    },
                    ExpressionAttributeValues: {
                      ":token": token,
                      ":until": leaseUntil,
                      ":now": now,
                      ":pending": "pending",
                    },
                  })
                  .pipe(
                    Effect.as(true),
                    Effect.catchIf(
                      lostRace,
                      (): Effect.Effect<boolean, PersistenceError> => Effect.succeed(false),
                    ),
                    Effect.mapError(persist("outbox.claim")),
                  );
                if (taken) {
                  const reloaded = yield* ddb
                    .get({
                      TableName: table,
                      Key: { [PK]: item.pk, [SK]: outboxSk },
                      ConsistentRead: true,
                    })
                    .pipe(Effect.mapError(persist("outbox.claim")));
                  const current = reloaded.Item as OutboxItem | undefined;
                  if (current !== undefined) claimed.push(decodeEntry(current));
                }
              }
              return { entries: claimed, token, leaseUntil } satisfies OutboxClaim;
            }),
          ),
        markPublished: (ids, claim) =>
          ids.length === 0
            ? Effect.succeed(false)
            : Effect.map(
                Effect.forEach(
                  ids,
                  (id) =>
                    settle(
                      id,
                      "SET #status = :published REMOVE #g2, #ct, #lu, #avail",
                      { ":published": "published" },
                      { "#g2": STATUS_KEY, "#ct": "ct", "#lu": "lu", "#avail": "avail" },
                      claim,
                      "outbox.markPublished",
                    ),
                  { discard: true },
                ),
                () => true,
              ),
        markFailed: (id, error, attempts, retryAt, claim) =>
          settle(
            id,
            retryAt === undefined
              ? "SET #attempts = :attempts, #lastError = :error REMOVE #avail"
              : "SET #attempts = :attempts, #lastError = :error, #avail = :retryAt",
            retryAt === undefined
              ? { ":attempts": attempts, ":error": error }
              : { ":attempts": attempts, ":error": error, ":retryAt": retryAt },
            retryAt === undefined
              ? { "#attempts": "attempts", "#lastError": "lastError", "#avail": "avail" }
              : { "#attempts": "attempts", "#lastError": "lastError", "#avail": "avail" },
            claim,
            "outbox.markFailed",
          ),
        markDead: (id, error, claim) =>
          // Dead entries stay in the sparse status GSI, moved to the `dead`
          // partition; the claim is released (settlement ends ownership).
          settle(
            id,
            "SET #status = :dead, #g2 = :dead, #lastError = :error REMOVE #ct, #lu",
            { ":dead": "dead", ":error": error },
            {
              "#status": "status",
              "#g2": STATUS_KEY,
              "#lastError": "lastError",
              "#ct": "ct",
              "#lu": "lu",
            },
            claim,
            "outbox.markDead",
          ),
        replay: (ids) =>
          Effect.forEach(
            ids,
            (id) =>
              ddb
                .update({
                  TableName: table,
                  Key: { [PK]: outboxPk(id), [SK]: outboxSk },
                  UpdateExpression:
                    "SET #status = :pending, #g2 = :pending, #attempts = :zero REMOVE #lastError, #avail, #ct, #lu",
                  ConditionExpression: "#status = :dead",
                  ExpressionAttributeNames: {
                    "#status": "status",
                    "#g2": STATUS_KEY,
                    "#attempts": "attempts",
                    "#lastError": "lastError",
                    "#avail": "avail",
                    "#ct": "ct",
                    "#lu": "lu",
                  },
                  ExpressionAttributeValues: { ":pending": "pending", ":zero": 0 },
                })
                .pipe(
                  // Unknown or non-dead ids are ignored.
                  Effect.catchIf(lostRace, () => Effect.void),
                  Effect.mapError(persist("outbox.replay")),
                  Effect.asVoid,
                ),
            { discard: true },
          ),
        deadLetters: () => queryByStatus("dead"),
      });
    }),
  );

/**
 * `Inbox` remembering processed (consumer, message) pairs, reclaimed by the
 * table TTL after a week. TTL deletion is best-effort and may lag (book
 * ch. 3.2), so `seen` also checks the expiry timestamp on read.
 */
export const inboxLayer = (
  options?: AdapterOptions,
): Layer.Layer<Inbox, never, DynamoDBDocumentService> =>
  Layer.effect(
    Inbox,
    Effect.gen(function* () {
      const ddb = yield* DynamoDBDocumentService;
      const table = tableName(options);
      return Inbox.of({
        seen: (consumerId, messageId) =>
          ddb
            .get({
              TableName: table,
              Key: { [PK]: inboxPk(consumerId), [SK]: messageId },
              ConsistentRead: true,
            })
            .pipe(
              Effect.map((output) => {
                const item = Option.fromNullable(output.Item) as Option.Option<{
                  readonly exp?: unknown;
                }>;
                if (Option.isNone(item)) return false;
                const exp = item.value.exp;
                return typeof exp === "number" ? exp > Date.now() / 1000 : true;
              }),
              Effect.mapError(persist("inbox.seen")),
            ),
        markProcessed: (consumerId, messageId) =>
          ddb
            .put({
              TableName: table,
              Item: {
                [PK]: inboxPk(consumerId),
                [SK]: messageId,
                [ENTITY]: "inbox",
                exp: Math.floor(Date.now() / 1000) + inboxRetentionSeconds,
              },
            })
            .pipe(Effect.asVoid, Effect.mapError(persist("inbox.markProcessed"))),
      });
    }),
  );
