import * as SqlClient from "@effect/sql/SqlClient";
import { PersistenceError } from "@structure-ai/domain";
import { type Snapshot, SnapshotStore } from "@structure-ai/eventsourcing";
import { Effect, Layer, Option } from "effect";
import { encodeJson, toNumber } from "./internal.js";
import { type AdapterOptions, tableNames } from "./schema.js";

interface SnapshotRow {
  readonly state: string;
  readonly version: number | bigint;
}

/** `SnapshotStore` keeping the latest snapshot per stream in `snapshots`. */
export const snapshotStoreLayer = (
  options?: AdapterOptions,
): Layer.Layer<SnapshotStore, never, SqlClient.SqlClient> =>
  Layer.effect(
    SnapshotStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const tables = tableNames(options);
      return SnapshotStore.of({
        load: (streamName) =>
          sql<SnapshotRow>`
            SELECT state, version
            FROM ${sql(tables.snapshots)}
            WHERE stream_name = ${streamName}
          `.pipe(
            Effect.mapError((cause) => new PersistenceError({ operation: "SnapshotStore", cause })),
            Effect.flatMap((rows) =>
              Effect.try({
                try: () => {
                  const row = rows[0];
                  return row === undefined
                    ? Option.none<Snapshot>()
                    : Option.some<Snapshot>({
                        state: JSON.parse(row.state) as unknown,
                        version: toNumber(row.version),
                      });
                },
                catch: (cause) => new PersistenceError({ operation: "snapshot.decode", cause }),
              }),
            ),
          ),
        save: (streamName, snapshot) =>
          Effect.gen(function* () {
            return yield* sql`
            INSERT INTO ${sql(tables.snapshots)} (stream_name, state, version)
            VALUES (${streamName}, ${yield* encodeJson(snapshot.state)}, ${snapshot.version})
            ON CONFLICT (stream_name) DO UPDATE
              SET state = excluded.state, version = excluded.version
          `.pipe(
              Effect.mapError(
                (cause) => new PersistenceError({ operation: "SnapshotStore", cause }),
              ),
              Effect.asVoid,
            );
          }),
        remove: (streamName) =>
          sql`
            DELETE FROM ${sql(tables.snapshots)} WHERE stream_name = ${streamName}
          `.pipe(
            Effect.mapError((cause) => new PersistenceError({ operation: "SnapshotStore", cause })),
            Effect.asVoid,
          ),
      });
    }),
  );
