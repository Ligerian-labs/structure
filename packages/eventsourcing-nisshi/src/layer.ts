import type * as SqlClient from "@effect/sql/SqlClient";
import type { SqlError } from "@effect/sql/SqlError";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import type {
  CheckpointStore,
  EventStore,
  Inbox,
  SnapshotStore,
} from "@structure-ai/eventsourcing";
import { Effect, Layer } from "effect";
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
 * `NisshiClient`. Run `migrate` first — or use `layer`, which does.
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

/**
 * Everything in one layer: the broker connection, the sqlite sidecar (schema
 * migration runs at layer build), topic verification, and the four port
 * adapters. The sidecar `SqlClient` is exposed for callers' own queries.
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
