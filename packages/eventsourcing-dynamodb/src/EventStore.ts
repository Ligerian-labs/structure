import type { TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { DynamoDBDocumentService } from "@effect-aws/dynamodb";
import { ConcurrencyConflict, PersistenceError } from "@structure-ai/domain";
import {
  type AppendEvent,
  type AppendResult,
  EventStore,
  type EventStoreService,
  type OutboxMessage,
  readAllPartitions,
  type StoredEvent,
  type StoredEventMetadata,
} from "@structure-ai/eventsourcing";
import { Effect, Layer, Option, Stream } from "effect";
import { conflictIdentity, isHeadConflict } from "./internal.js";
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

const persist =
  (operation: string) =>
  (cause: unknown): PersistenceError =>
    new PersistenceError({ operation, cause });

/** Whether a conditional transaction lost its optimistic-concurrency race. */
const lostRace = (error: unknown): boolean => isHeadConflict(error);

const make = (options?: AdapterOptions) =>
  Effect.gen(function* () {
    const ddb = yield* DynamoDBDocumentService;
    const table = tableName(options);

    const headVersion = (streamName: string): Effect.Effect<number, PersistenceError> =>
      ddb
        .get({
          TableName: table,
          Key: { [PK]: streamPk(streamName), [SK]: streamHeadSk },
          ConsistentRead: true,
        })
        .pipe(
          Effect.map((output) => {
            const item = Option.fromNullable(output.Item as Record<string, unknown> | undefined);
            return Option.isNone(item) ? 0 : streamVersionOf(item.value);
          }),
          Effect.mapError(persist("eventstore.head")),
        );

    const conflict = (
      streamName: string,
      expectedVersion: number,
    ): Effect.Effect<ConcurrencyConflict, PersistenceError> =>
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
     * the SQL adapters' constraint-violation path); everything else is a
     * typed `PersistenceError` (ADR-0020).
     */
    const appendTransaction = (
      streamName: string,
      expectedVersion: number,
      events: ReadonlyArray<AppendEvent>,
      messages: ReadonlyArray<OutboxMessage>,
    ): Effect.Effect<AppendResult, ConcurrencyConflict | PersistenceError> => {
      if (events.length + messages.length > maxTransactionEvents) {
        return Effect.fail(
          new PersistenceError({
            operation: "eventstore.append",
            cause: new Error(
              `append of ${events.length + messages.length} items exceeds the DynamoDB transaction limit of ${maxTransactionEvents}`,
            ),
          }),
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
        Effect.catchAll((error): Effect.Effect<never, ConcurrencyConflict | PersistenceError> => {
          if (lostRace(error)) {
            return Effect.flatMap(conflict(streamName, expectedVersion), (conflicted) =>
              Effect.fail(conflicted),
            );
          }
          return Effect.fail(
            new PersistenceError({ operation: "eventstore.append", cause: error }),
          );
        }),
      );
    };

    /**
     * The `feed` GSI paged: every page (1 MB) is followed until exhausted,
     * then the collected events flow as one stream. Filtering (partition)
     * happens client-side on decoded events — the filter is honoured, never
     * silently dropped (ADR-0018).
     */
    const readFeedPage = (
      afterUlid: string,
      limit: number | undefined,
      exclusiveStartKey?: Record<string, unknown>,
    ): Effect.Effect<
      { readonly items: ReadonlyArray<EventItem>; readonly lastKey?: Record<string, unknown> },
      PersistenceError
    > =>
      ddb
        .query({
          TableName: table,
          IndexName: "feed",
          KeyConditionExpression: "#g1 = :feed AND #pos >= :after",
          ExclusiveStartKey: exclusiveStartKey,
          ExpressionAttributeNames: { "#g1": FEED_KEY, "#pos": POSITION },
          ExpressionAttributeValues: { ":feed": "F", ":after": afterUlid },
          ...(limit !== undefined && { Limit: limit }),
        })
        .pipe(
          Effect.map((output) => {
            const lastKey = output.LastEvaluatedKey as Record<string, unknown> | undefined;
            return lastKey === undefined
              ? { items: (output.Items ?? []).map((item) => item as EventItem) }
              : {
                  items: (output.Items ?? []).map((item) => item as EventItem),
                  lastKey,
                };
          }),
          Effect.mapError(persist("eventstore.readAll")),
        );

    const readAllItems = (
      afterUlid: string,
      limit: number | undefined,
    ): Effect.Effect<ReadonlyArray<EventItem>, PersistenceError> =>
      Effect.suspend(() => {
        const collected: Array<EventItem> = [];
        const page = (
          key: Record<string, unknown> | undefined,
        ): Effect.Effect<void, PersistenceError> =>
          Effect.flatMap(readFeedPage(afterUlid, limit, key), (output) => {
            collected.push(...output.items);
            return output.lastKey === undefined ? Effect.void : page(output.lastKey);
          });
        return Effect.asVoid(page(undefined)).pipe(Effect.map(() => collected));
      });

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
              Effect.mapError(persist("eventstore.read")),
            ),
        ),
      readAll: (readOptions) =>
        Stream.unwrap(
          Effect.map(
            readAllItems(positionToUlid(readOptions?.fromPosition ?? 0n), readOptions?.batchSize),
            (items) => {
              const partitions = readAllPartitions(readOptions?.partition);
              const kept =
                partitions === undefined
                  ? items
                  : partitions.length === 0
                    ? []
                    : items.filter((item) => {
                        const partition = item.m.partition;
                        return partition !== undefined && partitions.includes(partition);
                      });
              // batchSize bounds the stream, not the page fetch: an
              // exhausted filter may need several pages to fill.
              const bounded =
                readOptions?.batchSize !== undefined ? kept.slice(0, readOptions.batchSize) : kept;
              return Stream.fromIterable(bounded.map(decodeEvent));
            },
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
  ) => Effect.Effect<AppendResult, ConcurrencyConflict | PersistenceError>;
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
 * message id fails the whole transaction and nothing persists.
 */
export const appendWithOutbox = (
  streamName: string,
  expectedVersion: number,
  events: ReadonlyArray<AppendEvent>,
  messages: ReadonlyArray<OutboxMessage>,
  options?: AdapterOptions,
): Effect.Effect<AppendResult, ConcurrencyConflict | PersistenceError, DynamoDBDocumentService> =>
  Effect.flatMap(make(options), (store: EventStoreWithOutbox) =>
    store.appendWithOutbox(streamName, expectedVersion, events, messages),
  );
