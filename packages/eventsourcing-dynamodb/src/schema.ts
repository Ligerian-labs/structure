import {
  type CreateGlobalSecondaryIndexAction,
  CreateTableCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  type DynamoDBClient,
  UpdateTableCommand,
  UpdateTimeToLiveCommand,
} from "@aws-sdk/client-dynamodb";
import type { OutboxMessage, StoredEventMetadata } from "@structure-ai/eventsourcing";
import { Context, Effect, Layer } from "effect";
import { DynamoDbError, dynamoError } from "./internal.js";
import { ulid } from "./ulid.js";

/**
 * Single-table layout (ADR-0015): one table, generic `pk`/`sk` keys with
 * entity prefixes, an `entity` discriminator per item, and two GSIs —
 * `feed` (global event order) and `status` (sparse outbox reads).
 *
 * | Entity | pk | sk | Notes |
 * | --- | --- | --- | --- |
 * | stream head | `S#<stream>` | `0` | `v` = current version; sorts before events |
 * | event | `S#<stream>` | `E#<version, 12 digits>` | `pos` ULID; `g1` feed key |
 * | snapshot | `S#<stream>` | `N` | `state`, `v` |
 * | checkpoint | `C#<name>` | `C` | `pos` ULID string |
 * | outbox message | `O#<id>` | `O` | sparse `g2` = pending/dead + `enq` ULID sort |
 * | inbox dedupe | `I#<consumer>` | `<messageId>` | `exp` TTL epoch seconds |
 */

/** Options shared by every adapter in this package. */
export interface AdapterOptions {
  /** The single table every port shares. Default: `structure`. */
  readonly tableName?: string;
}

export const defaultTableName = "structure";

export const tableName = (options?: AdapterOptions): string =>
  options?.tableName ?? defaultTableName;

// --- attribute names ------------------------------------------------------------

export const PK = "pk";
export const SK = "sk";
/** Item discriminator (book ch. 9.4): stream | event | snapshot | checkpoint | outbox | inbox. */
export const ENTITY = "entity";
/** Global-feed GSI key attribute (constant `F`), indexed by ULID position. */
export const FEED_KEY = "g1";
/** Sparse outbox-status GSI key attribute (`pending` | `dead`), indexed by enqueue ULID. */
export const STATUS_KEY = "g2";
/** Outbox enqueue-time ULID (the `status` GSI sort key). */
export const ENQ = "enq";
export const POSITION = "pos";
export const VERSION = "v";

// --- key builders ------------------------------------------------------------------

export const streamPk = (streamName: string): string => `S#${streamName}`;
/** Sorts before every `E#` event key, so stream reads never see the head. */
export const streamHeadSk = "0";
export const eventSk = (version: number): string => `E#${version.toString().padStart(12, "0")}`;
/** Exclusive upper bound for stream reads (`E#...` < `F` < `N`). */
export const eventSkCeiling = "F";
export const snapshotSk = "N";
export const checkpointPk = (name: string): string => `C#${name}`;
export const checkpointSk = "C";
export const outboxPk = (messageId: string): string => `O#${messageId}`;
export const outboxSk = "O";
export const inboxPk = (consumerId: string): string => `I#${consumerId}`;

/** Maximum items a DynamoDB transaction accepts; one slot goes to the stream head. */
export const maxTransactionEvents = 99;

// --- item builders -------------------------------------------------------------------

/** Reads the version off a stream-head item. */
export const streamVersionOf = (item: Record<string, unknown>): number =>
  typeof item[VERSION] === "number" ? (item[VERSION] as number) : 0;

/** One stored event as a table item (feed key + ULID position included). */
export const eventItem = (
  streamName: string,
  version: number,
  type: string,
  schemaVersion: number,
  payload: unknown,
  metadata: StoredEventMetadata,
): Record<string, unknown> => ({
  [PK]: streamPk(streamName),
  [SK]: eventSk(version),
  [ENTITY]: "event",
  [POSITION]: ulid(),
  [FEED_KEY]: "F",
  [VERSION]: version,
  t: type,
  sv: schemaVersion,
  p: payload,
  m: metadata,
});

/** One outbox message item: sparse `g2` present while pending, ULID `enq` sort. */
export const outboxItem = (message: OutboxMessage): Record<string, unknown> => ({
  [PK]: outboxPk(message.id),
  [SK]: outboxSk,
  [ENTITY]: "outbox",
  [STATUS_KEY]: "pending",
  [ENQ]: ulid(),
  topic: message.topic,
  p: message.payload,
  m: message.metadata,
  status: "pending",
  attempts: 0,
});

// --- ensureTables --------------------------------------------------------------------

const describeTable = (client: DynamoDBClient, name: string) =>
  Effect.tryPromise({
    try: () => client.send(new DescribeTableCommand({ TableName: name })),
    catch: dynamoError,
  });

const waitUntilActive = (
  client: DynamoDBClient,
  name: string,
  attempt = 0,
): Effect.Effect<void, DynamoDbError> =>
  describeTable(client, name).pipe(
    Effect.flatMap((description) =>
      description.Table?.TableStatus === "ACTIVE"
        ? Effect.void
        : attempt > 100
          ? Effect.fail(
              new DynamoDbError({
                classification: "transient",
                message: `table ${name} did not become active`,
              }),
            )
          : Effect.sleep("500 millis").pipe(
              Effect.andThen(waitUntilActive(client, name, attempt + 1)),
            ),
    ),
  );

const feedIndex: CreateGlobalSecondaryIndexAction = {
  IndexName: "feed",
  KeySchema: [
    { AttributeName: FEED_KEY, KeyType: "HASH" },
    { AttributeName: POSITION, KeyType: "RANGE" },
  ],
  Projection: { ProjectionType: "ALL" },
};

const statusIndex: CreateGlobalSecondaryIndexAction = {
  IndexName: "status",
  KeySchema: [
    { AttributeName: STATUS_KEY, KeyType: "HASH" },
    { AttributeName: ENQ, KeyType: "RANGE" },
  ],
  Projection: { ProjectionType: "ALL" },
};

/**
 * Idempotently ensures the single table exists with the `feed` and `status`
 * GSIs and the `exp` TTL enabled: creates it when missing, adds missing GSIs
 * via `UpdateTable` when it exists, and waits for `ACTIVE` throughout. Run
 * once at startup (the package-level `layer` does so automatically). This is
 * the DynamoDB replacement for `@structure-ai/migrations` (ADR-0005 is
 * SQL-only); evolving access patterns later means adding GSIs here.
 */
export const ensureTables = (
  options?: AdapterOptions,
): Effect.Effect<void, DynamoDbError, RawDynamoClient> =>
  Effect.gen(function* () {
    const name = tableName(options);
    // The document client serves data-plane commands only; table lifecycle
    // needs the control-plane client from context.
    const client = yield* RawDynamoClient;

    const existing = yield* describeTable(client, name).pipe(
      Effect.map((description) => description.Table),
      Effect.catchAll(() => Effect.succeed(undefined)),
    );

    if (existing === undefined) {
      yield* Effect.tryPromise({
        try: () =>
          client.send(
            new CreateTableCommand({
              TableName: name,
              BillingMode: "PAY_PER_REQUEST",
              KeySchema: [
                { AttributeName: PK, KeyType: "HASH" },
                { AttributeName: SK, KeyType: "RANGE" },
              ],
              AttributeDefinitions: [
                { AttributeName: PK, AttributeType: "S" },
                { AttributeName: SK, AttributeType: "S" },
                { AttributeName: FEED_KEY, AttributeType: "S" },
                { AttributeName: POSITION, AttributeType: "S" },
                { AttributeName: STATUS_KEY, AttributeType: "S" },
                { AttributeName: ENQ, AttributeType: "S" },
              ],
              GlobalSecondaryIndexes: [feedIndex, statusIndex],
            }),
          ),
        catch: dynamoError,
      });
    } else {
      const present = new Set(
        (existing.GlobalSecondaryIndexes ?? []).map((index) => index.IndexName),
      );
      const missing: Array<CreateGlobalSecondaryIndexAction> = [];
      if (!present.has("feed")) missing.push(feedIndex);
      if (!present.has("status")) missing.push(statusIndex);
      if (missing.length > 0) {
        yield* Effect.tryPromise({
          try: () =>
            client.send(
              new UpdateTableCommand({
                TableName: name,
                AttributeDefinitions: [
                  { AttributeName: FEED_KEY, AttributeType: "S" },
                  { AttributeName: POSITION, AttributeType: "S" },
                  { AttributeName: STATUS_KEY, AttributeType: "S" },
                  { AttributeName: ENQ, AttributeType: "S" },
                ],
                GlobalSecondaryIndexUpdates: missing.map((Create) => ({ Create })),
              }),
            ),
          catch: dynamoError,
        });
      }
    }

    yield* waitUntilActive(client, name);
    // DynamoDB Local rejects a no-op TTL update ("already enabled"), so the
    // current spec is checked first and only changed when it differs.
    const ttl = yield* Effect.tryPromise({
      try: () => client.send(new DescribeTimeToLiveCommand({ TableName: name })),
      catch: dynamoError,
    });
    const spec = (
      ttl as {
        readonly TimeToLiveDescription?: {
          readonly AttributeName?: string;
          readonly TimeToLiveStatus?: string;
        };
      }
    ).TimeToLiveDescription;
    if (spec?.AttributeName !== "exp" || spec.TimeToLiveStatus !== "ENABLED") {
      yield* Effect.tryPromise({
        try: () =>
          client.send(
            new UpdateTimeToLiveCommand({
              TableName: name,
              TimeToLiveSpecification: { AttributeName: "exp", Enabled: true },
            }),
          ),
        catch: dynamoError,
      });
    }
  });

/** The raw control-plane client `ensureTables` uses (create/describe/update table). */
export class RawDynamoClient extends Context.Tag(
  "@structure-ai/eventsourcing-dynamodb/RawDynamoClient",
)<RawDynamoClient, DynamoDBClient>() {
  static readonly layer = (client: DynamoDBClient): Layer.Layer<RawDynamoClient> =>
    Layer.succeed(RawDynamoClient, client);
}
