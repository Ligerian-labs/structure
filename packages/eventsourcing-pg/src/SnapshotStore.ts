import * as SqlClient from "@effect/sql/SqlClient";
import { type Snapshot, SnapshotStore } from "@structure/eventsourcing";
import { Effect, Layer, Option } from "effect";
import { jsonText, toNumber } from "./internal.js";
import { type AdapterOptions, tableNames } from "./schema.js";

interface SnapshotRow {
  readonly state: string;
  readonly version: number | bigint | string;
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
            SELECT state::text AS state, version
            FROM ${sql(tables.snapshots)}
            WHERE stream_name = ${streamName}
          `.pipe(
            Effect.orDie,
            Effect.map((rows) => {
              const row = rows[0];
              return row === undefined
                ? Option.none<Snapshot>()
                : Option.some<Snapshot>({
                    state: JSON.parse(row.state) as unknown,
                    version: toNumber(row.version),
                  });
            }),
          ),
        save: (streamName, snapshot) =>
          sql`
            INSERT INTO ${sql(tables.snapshots)} (stream_name, state, version)
            VALUES (${streamName}, ${jsonText(snapshot.state)}::jsonb, ${snapshot.version})
            ON CONFLICT (stream_name) DO UPDATE
              SET state = excluded.state, version = excluded.version
          `.pipe(Effect.orDie, Effect.asVoid),
      });
    }),
  );
