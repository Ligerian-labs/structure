import { DynamoDBDocumentService } from "@effect-aws/dynamodb";
import { Inbox, Outbox, type OutboxEntry, type OutboxStatus } from "@structure-ai/eventsourcing";
import { Effect, Layer } from "effect";
import { dynamoError } from "./internal.js";
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
}

const decodeEntry = (item: OutboxItem): OutboxEntry => {
  const entry: OutboxEntry = {
    message: { id: item.pk.slice(2), topic: item.topic, payload: item.p, metadata: item.m },
    status: item.status as OutboxStatus,
    attempts: item.attempts,
  };
  return item.lastError === undefined ? entry : { ...entry, lastError: item.lastError };
};

/**
 * `Outbox` staging messages as items in the single table. `enqueue` is
 * idempotent per message id (`attribute_not_exists` condition); enqueue
 * order is the ULID `enq` attribute through the sparse `status` GSI, which
 * carries only non-terminal entries — published messages vanish from the
 * index when the attribute is removed (book ch. 13.4, sparse indexes).
 */
export const outboxLayer = (
  options?: AdapterOptions,
): Layer.Layer<Outbox, never, DynamoDBDocumentService> =>
  Layer.effect(
    Outbox,
    Effect.gen(function* () {
      const ddb = yield* DynamoDBDocumentService;
      const table = tableName(options);

      const entries = (status: "pending" | "dead", limit?: number) =>
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
            Effect.catchAll((error) => Effect.die(dynamoError(error))),
          );

      const update = (
        messageId: string,
        updateExpression: string,
        values: Record<string, unknown>,
        names: Record<string, string>,
      ) =>
        ddb
          .update({
            TableName: table,
            Key: { [PK]: outboxPk(messageId), [SK]: outboxSk },
            UpdateExpression: updateExpression,
            ExpressionAttributeValues: values,
            ExpressionAttributeNames: names,
          })
          .pipe(
            Effect.asVoid,
            Effect.catchAll((error) => Effect.die(dynamoError(error))),
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
                  Effect.catchAll((error) => Effect.die(dynamoError(error))),
                ),
            { discard: true },
          ),
        pending: (limit) => entries("pending", limit),
        markPublished: (ids) =>
          Effect.forEach(
            ids,
            (id) =>
              update(
                id,
                "SET #status = :published REMOVE #g2",
                { ":published": "published" },
                { "#status": "status", "#g2": STATUS_KEY },
              ),
            { discard: true },
          ),
        markFailed: (id, error, attempts) =>
          update(
            id,
            "SET #attempts = :attempts, #lastError = :error",
            { ":attempts": attempts, ":error": error },
            { "#attempts": "attempts", "#lastError": "lastError" },
          ),
        markDead: (id, error) =>
          // Dead entries stay in the sparse status GSI, moved to the `dead`
          // partition; only `markPublished` removes the key entirely.
          update(
            id,
            "SET #status = :dead, #g2 = :dead, #lastError = :error",
            { ":dead": "dead", ":error": error },
            { "#status": "status", "#lastError": "lastError", "#g2": STATUS_KEY },
          ),
        deadLetters: () => entries("dead"),
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
                const item = output.Item as { exp?: unknown } | undefined;
                if (item === undefined) return false;
                return typeof item.exp === "number" ? item.exp > Date.now() / 1000 : true;
              }),
              Effect.catchAll((error) => Effect.die(dynamoError(error))),
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
            .pipe(
              Effect.asVoid,
              Effect.catchAll((error) => Effect.die(dynamoError(error))),
            ),
      });
    }),
  );
