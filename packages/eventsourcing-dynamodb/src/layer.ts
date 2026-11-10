import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoDBDocumentService } from "@effect-aws/dynamodb";
import type {
  CheckpointStore,
  EventStore,
  Inbox,
  Outbox,
  SnapshotStore,
} from "@structure-ai/eventsourcing";
import { Layer, Redacted } from "effect";
import { eventStoreLayer } from "./EventStore.js";
import type { DynamoDbError } from "./internal.js";
import { inboxLayer, outboxLayer } from "./Outbox.js";
import { checkpointStoreLayer, snapshotStoreLayer } from "./SnapshotStore.js";
import { type AdapterOptions, ensureTables, RawDynamoClient } from "./schema.js";

/** All five ports this package implements. */
export type StoreServices = EventStore | SnapshotStore | CheckpointStore | Outbox | Inbox;

/**
 * Every adapter merged, on top of an existing `DynamoDBDocumentService`.
 * Assumes the table exists with its GSIs (run `ensureTables` first, or use
 * {@link layer}, which does).
 */
export const storesLayer = (
  options?: AdapterOptions,
): Layer.Layer<StoreServices, never, DynamoDBDocumentService> =>
  Layer.mergeAll(
    eventStoreLayer(options),
    snapshotStoreLayer(options),
    checkpointStoreLayer(options),
    outboxLayer(options),
    inboxLayer(options),
  );

/** Connection settings; in production these come from typed, secret-backed settings. */
export interface DynamoDbConnection {
  /** AWS region of the table. */
  readonly region: string;
  /** Custom endpoint (DynamoDB Local, LocalStack, VPC endpoint). */
  readonly endpoint?: string;
  /** Static credentials; omit for the default AWS credential chain. */
  readonly accessKeyId?: string;
  /** Companion secret for `accessKeyId`. */
  readonly secretAccessKey?: Redacted.Redacted<string>;
}

const staticCredentials = (connection: DynamoDbConnection) =>
  connection.accessKeyId !== undefined && connection.secretAccessKey !== undefined
    ? {
        credentials: {
          accessKeyId: connection.accessKeyId,
          secretAccessKey: Redacted.value(connection.secretAccessKey),
        },
      }
    : {};

const rawClientOf = (connection: DynamoDbConnection): DynamoDBClient =>
  new DynamoDBClient({
    region: connection.region,
    ...(connection.endpoint !== undefined && { endpoint: connection.endpoint }),
    ...staticCredentials(connection),
  });

/**
 * The document-client layer: `@effect-aws/dynamodb` over a
 * `DynamoDBDocumentClient` built from {@link DynamoDbConnection}. Marshall
 * options remove undefined values so optional attributes stay absent
 * rather than null.
 */
export const clientLayer = (connection: DynamoDbConnection): Layer.Layer<DynamoDBDocumentService> =>
  DynamoDBDocumentService.baseLayer(() =>
    DynamoDBDocumentClient.from(rawClientOf(connection), {
      marshallOptions: { removeUndefinedValues: true },
    }),
  );

/** Options for the all-in-one {@link layer}. */
export interface DynamoDbAdaptersConfig extends AdapterOptions, DynamoDbConnection {}

/**
 * Everything in one layer: the document client (from the connection
 * settings), `ensureTables` (idempotent create + GSIs + TTL, run at layer
 * build, before the stores), and all five port adapters. The document
 * client is exposed too, so callers can run their own table operations.
 */
export const layer = (
  config: DynamoDbAdaptersConfig,
): Layer.Layer<StoreServices | DynamoDBDocumentService, DynamoDbError, never> => {
  const { tableName: _tableName, ...connection } = config;
  const client = clientLayer(connection);
  const ensured = Layer.effectDiscard(ensureTables(config)).pipe(
    Layer.provide(RawDynamoClient.layer(rawClientOf(connection))),
    Layer.provideMerge(client),
  );
  // The client is shared (memoized) between `ensured` and the stores, and
  // `ensured` is a dependency, so the table exists before any store builds.
  return storesLayer(config).pipe(Layer.provideMerge(client), Layer.provide(ensured));
};
