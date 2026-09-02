import type * as SqlClient from "@effect/sql/SqlClient";
import type { SqlError } from "@effect/sql/SqlError";
import { PgClient } from "@effect/sql-pg";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import type {
  CheckpointStore,
  EventStore,
  Inbox,
  SnapshotStore,
} from "@structure-ai/eventsourcing";
import { Effect, Layer, Redacted } from "effect";
import type { ConfigError } from "effect/ConfigError";
import { type EventStoreOptions, eventStoreLayer } from "./EventStore.js";
import { NisshiClient, nisshiClientLayer } from "./protocol/client.js";
import type { NisshiConnectionError } from "./protocol/errors.js";
import { checkpointStoreLayer, inboxLayer, snapshotStoreLayer } from "./Stores.js";
import { migrate } from "./sidecar.js";

/**
 * The four ports this package implements. There is no `Outbox` by design:
 * the event topic itself is the publication (ADR-0015); apps needing
 * arbitrary notifications run consumers that produce derived topics.
 */
export type StoreServices = EventStore | SnapshotStore | CheckpointStore | Inbox;

/**
 * All adapters over an existing `SqlClient` (the sidecar) and an existing
 * `NisshiClient`. Run `migrate` first, or use `layer` or `layerPg`, which do.
 */
export const storesLayer = (
  options?: EventStoreOptions,
): Layer.Layer<StoreServices, never, SqlClient.SqlClient | NisshiClient> =>
  Layer.mergeAll(
    eventStoreLayer(options),
    snapshotStoreLayer(options),
    checkpointStoreLayer(options),
    inboxLayer(options),
  );

/** Configuration for the all-in-one `layer`: broker plus sqlite sidecar. */
export interface NisshiAdaptersConfig extends EventStoreOptions {
  /** Broker listener, e.g. `tcp://127.0.0.1:9092`. Must equal the broker's advertised listener. */
  readonly brokerUrl: string;
  /** Client id sent with every request (default `structure-nisshi`). */
  readonly clientId?: string;
  /** Per-request timeout in millis (default 10 000). */
  readonly timeoutMillis?: number;
  /** Sidecar database file, or `":memory:"` for an in-memory sidecar. */
  readonly filename: string;
  /** Create the topic (single partition) at layer start when missing (default true). */
  readonly createTopic?: boolean;
}

/** Configuration for the all-in-one `layerPg`: broker plus PostgreSQL sidecar. */
export interface NisshiPgConfig extends EventStoreOptions {
  /** Broker listener, e.g. `tcp://127.0.0.1:9092`. Must equal the broker's advertised listener. */
  readonly brokerUrl: string;
  /** Client id sent with every request (default `structure-nisshi`). */
  readonly clientId?: string;
  /** Per-request timeout in millis (default 10 000). */
  readonly timeoutMillis?: number;
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
  /** Create the topic (single partition) at layer start when missing (default true). */
  readonly createTopic?: boolean;
}

/**
 * Everything in one layer over a PostgreSQL sidecar: broker connection, pg
 * `SqlClient` (schema migration runs at layer build), topic verification,
 * and the four port adapters. The sidecar client is exposed too.
 */
export const layerPg = (
  options: NisshiPgConfig,
): Layer.Layer<
  StoreServices | PgClient.PgClient | SqlClient.SqlClient | NisshiClient,
  SqlError | NisshiConnectionError
> => {
  const client = nisshiClientLayer({
    brokerUrl: options.brokerUrl,
    clientId: options.clientId,
    timeoutMillis: options.timeoutMillis,
  });
  const url = options.url ?? process.env.DATABASE_URL;
  const sidecar = PgClient.layer({
    ...(url !== undefined ? { url: Redacted.make(url) } : {}),
    ...(options.maxConnections !== undefined ? { maxConnections: options.maxConnections } : {}),
    ...(options.applicationName !== undefined ? { applicationName: options.applicationName } : {}),
  });
  const migrated = Layer.effectDiscard(migrate(options)).pipe(Layer.provideMerge(sidecar));
  const ensured =
    options.createTopic === false
      ? client
      : Layer.effectDiscard(
          Effect.flatMap(NisshiClient, (c) =>
            c.ensureTopic(options.topic ?? "events").pipe(Effect.orDie),
          ),
        ).pipe(Layer.provideMerge(client));
  return storesLayer(options).pipe(Layer.provideMerge(migrated), Layer.provideMerge(ensured));
};
/**
 * Everything in one layer over a sqlite sidecar: broker connection, sqlite
 * `SqlClient` (schema migration runs at layer build), topic verification,
 * and the four port adapters. The sidecar `SqlClient` is exposed for
 * callers' own queries. For a PostgreSQL sidecar use `layerPg`.
 */
export const layer = (
  options: NisshiAdaptersConfig,
): Layer.Layer<
  StoreServices | SqliteClient.SqliteClient | SqlClient.SqlClient | NisshiClient,
  ConfigError | SqlError | NisshiConnectionError
> => {
  const client = nisshiClientLayer({
    brokerUrl: options.brokerUrl,
    clientId: options.clientId,
    timeoutMillis: options.timeoutMillis,
  });
  const sidecar = SqliteClient.layer({ filename: options.filename });
  const migrated = Layer.effectDiscard(migrate(options)).pipe(Layer.provideMerge(sidecar));
  const ensured =
    options.createTopic === false
      ? client
      : Layer.effectDiscard(
          Effect.flatMap(NisshiClient, (c) =>
            c.ensureTopic(options.topic ?? "events").pipe(Effect.orDie),
          ),
        ).pipe(Layer.provideMerge(client));
  return storesLayer(options).pipe(Layer.provideMerge(migrated), Layer.provideMerge(ensured));
};
