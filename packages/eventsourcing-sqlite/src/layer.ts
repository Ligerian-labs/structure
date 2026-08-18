import type * as SqlClient from "@effect/sql/SqlClient";
import type { SqlError } from "@effect/sql/SqlError";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import type {
  CheckpointStore,
  EventStore,
  Inbox,
  Outbox,
  SnapshotStore,
} from "@structure/eventsourcing";
import { Layer } from "effect";
import type { ConfigError } from "effect/ConfigError";
import { checkpointStoreLayer } from "./CheckpointStore.js";
import { eventStoreLayer } from "./EventStore.js";
import { inboxLayer, outboxLayer } from "./Outbox.js";
import { snapshotStoreLayer } from "./SnapshotStore.js";
import { type AdapterOptions, migrate } from "./schema.js";

/** All five ports this package implements. */
export type StoreServices = EventStore | SnapshotStore | CheckpointStore | Outbox | Inbox;

/**
 * Every adapter merged, on top of an existing `SqlClient`. Assumes the
 * tables exist (run `migrate` first, or use `layer` which does).
 */
export const storesLayer = (
  options?: AdapterOptions,
): Layer.Layer<StoreServices, never, SqlClient.SqlClient> =>
  Layer.mergeAll(
    eventStoreLayer(options),
    snapshotStoreLayer(options),
    checkpointStoreLayer(options),
    outboxLayer(options),
    inboxLayer(options),
  );

/** Configuration for the all-in-one `layer`. */
export interface SqliteAdaptersConfig extends AdapterOptions {
  /** Database file path, or `":memory:"` for an in-memory database. */
  readonly filename: string;
  /** Disable WAL journaling (defaults to WAL enabled). */
  readonly disableWAL?: boolean;
}

/**
 * Everything in one layer: a bun:sqlite `SqlClient` for `filename`, the
 * schema migration (run at layer build), and all five port adapters. The
 * client is exposed too, so callers can run their own queries.
 */
export const layer = (
  options: SqliteAdaptersConfig,
): Layer.Layer<
  StoreServices | SqliteClient.SqliteClient | SqlClient.SqlClient,
  ConfigError | SqlError
> => {
  const client = SqliteClient.layer({
    filename: options.filename,
    disableWAL: options.disableWAL,
  });
  const migrated = Layer.effectDiscard(migrate(options)).pipe(Layer.provideMerge(client));
  return storesLayer(options).pipe(Layer.provideMerge(migrated));
};
