import type * as SqlClient from "@effect/sql/SqlClient";
import type { SqlError } from "@effect/sql/SqlError";
import { PgClient } from "@effect/sql-pg";
import type { IdempotencyStore } from "@structure-ai/cqrs";
import type {
  CheckpointStore,
  EventStore,
  HistoryImporter,
  Inbox,
  Outbox,
  SnapshotStore,
} from "@structure-ai/eventsourcing";
import { Layer, Redacted } from "effect";
import { checkpointStoreLayer } from "./CheckpointStore.js";
import { eventStoreLayer } from "./EventStore.js";
import { idempotencyStoreLayer } from "./IdempotencyStore.js";
import { inboxLayer, outboxLayer } from "./Outbox.js";
import { snapshotStoreLayer } from "./SnapshotStore.js";
import { type AdapterOptions, migrate } from "./schema.js";

/** Eventsourcing ports, frozen-history importer, and the cqrs idempotency store. */
export type StoreServices =
  | EventStore
  | HistoryImporter
  | SnapshotStore
  | CheckpointStore
  | Outbox
  | Inbox
  | IdempotencyStore;

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
    idempotencyStoreLayer(options),
  );

/** Configuration for the all-in-one `layer`. */
export interface PgAdaptersConfig extends AdapterOptions {
  /**
   * Postgres connection URL. Defaults to the `DATABASE_URL` environment
   * variable; when neither is set, the client falls back to libpq-style
   * defaults (localhost:5432, OS user).
   */
  readonly url?: string;
  /** Maximum pool connections (driver default when omitted). */
  readonly maxConnections?: number;
  /** `application_name` reported to the server. */
  readonly applicationName?: string;
}

/**
 * Everything in one layer: a `PgClient` (configured from `options.url` or
 * `DATABASE_URL`), the schema migration (run at layer build), and every
 * adapter in `storesLayer`. The client is exposed too, so callers can run
 * their own queries.
 */
export const layer = (
  options?: PgAdaptersConfig,
): Layer.Layer<StoreServices | PgClient.PgClient | SqlClient.SqlClient, SqlError> => {
  const url = options?.url ?? process.env.DATABASE_URL;
  const client = PgClient.layer({
    ...(url !== undefined ? { url: Redacted.make(url) } : {}),
    ...(options?.maxConnections !== undefined ? { maxConnections: options.maxConnections } : {}),
    ...(options?.applicationName !== undefined ? { applicationName: options.applicationName } : {}),
  });
  const migrated = Layer.effectDiscard(migrate(options)).pipe(Layer.provideMerge(client));
  return storesLayer(options).pipe(Layer.provideMerge(migrated));
};
