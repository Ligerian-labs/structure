import type { TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { DynamoDBDocumentService } from "@effect-aws/dynamodb";
import { ConcurrencyConflict } from "@structure-ai/domain";
import {
  type AppendEvent,
  type AppendResult,
  EventStore,
  type EventStoreService,
  type OutboxMessage,
  type StoredEvent,
  type StoredEventMetadata,
} from "@structure-ai/eventsourcing";
import { Effect, Layer, Stream } from "effect";
import { conflictIdentity, dynamoError, isHeadConflict } from "./internal.js";
import {
  type AdapterOptions,
  eventItem,
  eventSk,
  eventSkCeiling,
  FEED_KEY,
  maxTransactionEvents,
  outboxItem,
  PK,
  POSITION,
  SK,
  streamHeadSk,
  streamPk,
  streamVersionOf,
  tableName,
  VERSION,
} from "./schema.js";
import { positionToUlid, ulidToPosition } from "./ulid.js";

/** A stored event as marshalled by the document client (all attributes). */
interface EventItem {
  readonly pk: string;
  readonly sk: string;
  readonly entity: "event";
  readonly pos: string;
  readonly g1: string;
  readonly v: number;
  readonly t: string;
  readonly sv: number;
  readonly p: unknown;
  readonly m: StoredEventMetadata;
}

const decodeEvent = (item: EventItem): StoredEvent => ({
  position: ulidToPosition(item.pos),
  streamName: item.pk.slice(2),
  version: item.v,
  type: item.t,
  schemaVersion: item.sv,
  payload: item.p,
  metadata: item.m,
});

const make = (options?: AdapterOptions) =>
  Effect.gen(function* () {
    const ddb = yield* DynamoDBDocumentService;
    const table = tableName(options);

    const headVersion = (streamName: string): Effect.Effect<number> =>
      ddb
        .get({
          TableName: table,
          Key: { [PK]: streamPk(streamName), [SK]: streamHeadSk },
          ConsistentRead: true,
        })
        .pipe(
          Effect.map((output) => {
            const item = output.Item as Record<string, unknown> | undefined;
            return item === undefined ? 0 : streamVersionOf(item);
          }),
          Effect.catchAll((error) => Effect.die(dynamoError(error))),
        );

    const conflict = (
      streamName: string,
      expectedVersion: number,
    ): Effect.Effect<ConcurrencyConflict> =>
      Effect.map(headVersion(streamName), (actualVersion) => {
        const { entity, id } = conflictIdentity(streamName);
        return new ConcurrencyConflict({ entity, id, expectedVersion, actualVersion });
      });

    /**
     * The transactional append: one `TransactWriteItems` holding the
     * conditional stream-head update (`if_not_exists(v, 0) = :expected` —
     * the optimistic-concurrency gate) plus the event puts, and, with
     * `appendWithOutbox`, the outbox puts. Conditional-check failures map
     * to `ConcurrencyConflict` with the actual version re-read (mirroring
     * the SQL adapters' constraint-violation path).
     */
    const appendTransaction = (
      streamName: string,
      expectedVersion: number,
      events: ReadonlyArray<AppendEvent>,
      messages: ReadonlyArray<OutboxMessage>,
    ): Effect.Effect<AppendResult, ConcurrencyConflict> => {
      if (events.length + messages.length > maxTransactionEvents) {
        return Effect.die(
          new Error(
            `append of ${events.length + messages.length} items exceeds the DynamoDB transaction limit of ${maxTransactionEvents}`,
          ),
        );
      }
      const lastVersion = expectedVersion + events.length;
      const writes: NonNullable<TransactWriteCommandInput["TransactItems"]> = [
        {
          Update: {
            TableName: table,
            Key: { [PK]: streamPk(streamName), [SK]: streamHeadSk },
            UpdateExpression: "SET #v = :new",
            // `if_not_exists` is not allowed in condition expressions: an
            // expected version of 0 means the head must not exist yet.
            ConditionExpression:
              expectedVersion === 0 ? "attribute_not_exists(#v)" : "#v = :expected",
            ExpressionAttributeNames: { "#v": VERSION },
            ExpressionAttributeValues: {
              ":new": lastVersion,
              ...(expectedVersion !== 0 && { ":expected": expectedVersion }),
            },
          },
        },
      ];
      events.forEach((event, index) => {
        writes.push({
          Put: {
            TableName: table,
            Item: eventItem(
              streamName,
              expectedVersion + index + 1,
              event.type,
              event.schemaVersion,
              event.payload,
              event.metadata,
            ),
          },
        });
      });
      for (const message of messages) {
        writes.push({
          Put: {
            TableName: table,
            Item: outboxItem(message),
            // Inside the transaction a duplicate message id must fail the
            // whole transaction (unlike `Outbox.enqueue`, which is
            // idempotent), so events and messages commit or roll back
            // together — same contract as the SQL adapters.
            ConditionExpression: "attribute_not_exists(#pk)",
            ExpressionAttributeNames: { "#pk": PK },
          },
        });
      }
      return ddb.transactWrite({ TransactItems: writes }).pipe(
        Effect.as(
          events.length === 0
            ? { firstVersion: expectedVersion, lastVersion: expectedVersion }
            : { firstVersion: expectedVersion + 1, lastVersion },
        ),
        Effect.catchAll((error): Effect.Effect<never, ConcurrencyConflict> => {
          const tag = (error as { readonly _tag?: string })._tag;
          if (tag === "ConcurrencyConflict") {
            return Effect.fail(error as unknown as ConcurrencyConflict);
          }
          return isHeadConflict(error)
            ? Effect.flatMap(conflict(streamName, expectedVersion), (conflicted) =>
                Effect.fail(conflicted),
              )
            : Effect.die(dynamoError(error));
        }),
      );
    };

    const service = EventStore.of({
      append: (streamName, expectedVersion, events) =>
        appendTransaction(streamName, expectedVersion, events, []),
      read: (streamName, readOptions) =>
        Stream.unwrap(
          ddb
            .query({
              TableName: table,
              // BETWEEN bounds reads to event items: the head (`0`) and
              // snapshots (`N`) sort outside the `E#…`-`F` range.
              KeyConditionExpression: "#pk = :pk AND #sk BETWEEN :from AND :cap",
              ConsistentRead: true,
              ExpressionAttributeNames: { "#pk": PK, "#sk": SK },
              ExpressionAttributeValues: {
                ":pk": streamPk(streamName),
                ":from": eventSk(readOptions?.fromVersion ?? 1),
                ":cap": eventSkCeiling,
              },
            })
            .pipe(
              Effect.map((output) =>
                Stream.fromIterable(
                  (output.Items ?? []).map((item) => decodeEvent(item as EventItem)),
                ),
              ),
              Effect.catchAll((error) => Effect.die(dynamoError(error))),
            ),
        ),
      readAll: (readOptions) =>
        Stream.unwrap(
          ddb
            .query({
              TableName: table,
              IndexName: "feed",
              KeyConditionExpression: "#g1 = :feed AND #pos >= :after",
              ExpressionAttributeNames: { "#g1": FEED_KEY, "#pos": POSITION },
              ExpressionAttributeValues: {
                ":feed": "F",
                ":after": positionToUlid(readOptions?.fromPosition ?? 0n),
              },
              ...(readOptions?.batchSize !== undefined && { Limit: readOptions.batchSize }),
            })
            .pipe(
              Effect.map((output) =>
                Stream.fromIterable(
                  (output.Items ?? []).map((item) => decodeEvent(item as EventItem)),
                ),
              ),
              Effect.catchAll((error) => Effect.die(dynamoError(error))),
            ),
        ),
    });

    return { service, appendWithOutbox: appendTransaction };
  });

interface EventStoreWithOutbox {
  readonly service: EventStoreService;
  readonly appendWithOutbox: (
    streamName: string,
    expectedVersion: number,
    events: ReadonlyArray<AppendEvent>,
    messages: ReadonlyArray<OutboxMessage>,
  ) => Effect.Effect<AppendResult, ConcurrencyConflict>;
}

/** `EventStore` backed by the single table of the `DynamoDBDocumentService` in context. */
export const eventStoreLayer = (
  options?: AdapterOptions,
): Layer.Layer<EventStore, never, DynamoDBDocumentService> =>
  Layer.effect(
    EventStore,
    Effect.map(make(options), (store: EventStoreWithOutbox) => store.service),
  );

/**
 * Transactional-outbox append: appends `events` to `streamName` (same
 * optimistic-concurrency contract as `EventStore.append`) and stages
 * `messages` in the outbox, all in ONE DynamoDB transaction — the messages
 * exist iff the events committed. Unlike `Outbox.enqueue`, a duplicate
 * message id fails the whole transaction (as a defect) and nothing persists.
 */
export const appendWithOutbox = (
  streamName: string,
  expectedVersion: number,
  events: ReadonlyArray<AppendEvent>,
  messages: ReadonlyArray<OutboxMessage>,
  options?: AdapterOptions,
): Effect.Effect<AppendResult, ConcurrencyConflict, DynamoDBDocumentService> =>
  Effect.flatMap(make(options), (store: EventStoreWithOutbox) =>
    store.appendWithOutbox(streamName, expectedVersion, events, messages),
  );
