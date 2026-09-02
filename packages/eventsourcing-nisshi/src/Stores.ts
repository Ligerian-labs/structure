import * as SqlClient from "@effect/sql/SqlClient";
import {
  CheckpointStore,
  type CheckpointStoreService,
  Inbox,
  type InboxService,
  SnapshotStore,
  type SnapshotStoreService,
} from "@structure-ai/eventsourcing";
import { Effect, Layer, Option } from "effect";
import { type SidecarOptions, sidecarTables } from "./sidecar.js";

const toBigInt = (value: number | bigint | string | null | undefined): bigint =>
  value === null || value === undefined ? 0n : BigInt(value);

interface SnapshotRow {
  readonly state: string;
  readonly version: number | bigint | string;
}

/** `SnapshotStore` over the sidecar table: latest state per stream, replacing on save. */
export const snapshotStoreLayer = (
  options?: SidecarOptions,
): Layer.Layer<SnapshotStore, never, SqlClient.SqlClient> => {
  const tables = sidecarTables(options);
  return Layer.effect(
    SnapshotStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const service: SnapshotStoreService = {
        load: (streamName) =>
          Effect.map(
            sql<SnapshotRow>`
              SELECT state, version FROM ${sql(tables.snapshots)} WHERE stream_name = ${streamName}
            `.pipe(Effect.orDie),
            (rows): Option.Option<{ state: unknown; version: number }> => {
              const row = rows[0];
              return row === undefined
                ? Option.none()
                : Option.some({
                    state: JSON.parse(row.state) as unknown,
                    version: Number(row.version),
                  });
            },
          ),
        save: (streamName, snapshot) =>
          Effect.asVoid(sql`
            INSERT INTO ${sql(tables.snapshots)} (stream_name, state, version)
            VALUES (${streamName}, ${JSON.stringify(snapshot.state ?? null)}, ${snapshot.version})
            ON CONFLICT (stream_name) DO UPDATE SET state = excluded.state, version = excluded.version
          `).pipe(Effect.orDie),
      };
      return SnapshotStore.of(service);
    }),
  );
};

/** `CheckpointStore` over the sidecar table: one bigint position per consumer name. */
export const checkpointStoreLayer = (
  options?: SidecarOptions,
): Layer.Layer<CheckpointStore, never, SqlClient.SqlClient> => {
  const tables = sidecarTables(options);
  return Layer.effect(
    CheckpointStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const service: CheckpointStoreService = {
        load: (name) =>
          Effect.map(
            sql<{ readonly position: number | bigint | string | null }>`
              SELECT position FROM ${sql(tables.checkpoints)} WHERE name = ${name}
            `.pipe(Effect.orDie),
            (rows) => toBigInt(rows[0]?.position),
          ),
        save: (name, position) =>
          Effect.asVoid(sql`
            INSERT INTO ${sql(tables.checkpoints)} (name, position)
            VALUES (${name}, ${position})
            ON CONFLICT (name) DO UPDATE SET position = excluded.position
          `).pipe(Effect.orDie),
      };
      return CheckpointStore.of(service);
    }),
  );
};

/** `Inbox` over the sidecar table: processed `(consumer, message)` pairs. */
export const inboxLayer = (
  options?: SidecarOptions,
): Layer.Layer<Inbox, never, SqlClient.SqlClient> => {
  const tables = sidecarTables(options);
  return Layer.effect(
    Inbox,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const service: InboxService = {
        seen: (consumerId, messageId) =>
          Effect.map(
            sql<{ readonly one: number }>`
              SELECT 1 AS one FROM ${sql(tables.inbox)}
              WHERE consumer_id = ${consumerId} AND message_id = ${messageId}
            `.pipe(Effect.orDie),
            (rows) => rows.length > 0,
          ),
        markProcessed: (consumerId, messageId) =>
          Effect.asVoid(sql`
            INSERT INTO ${sql(tables.inbox)} (consumer_id, message_id)
            VALUES (${consumerId}, ${messageId})
            ON CONFLICT DO NOTHING
          `).pipe(Effect.orDie),
      };
      return Inbox.of(service);
    }),
  );
};
