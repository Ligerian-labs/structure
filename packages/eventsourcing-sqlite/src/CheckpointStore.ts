import * as SqlClient from "@effect/sql/SqlClient";
import { CheckpointStore } from "@structure-ai/eventsourcing";
import { Effect, Layer } from "effect";
import { toBigInt } from "./internal.js";
import { type AdapterOptions, tableNames } from "./schema.js";

interface CheckpointRow {
  readonly position: number | bigint;
}

/** `CheckpointStore` persisting consumer positions in `checkpoints`. */
export const checkpointStoreLayer = (
  options?: AdapterOptions,
): Layer.Layer<CheckpointStore, never, SqlClient.SqlClient> =>
  Layer.effect(
    CheckpointStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const tables = tableNames(options);
      return CheckpointStore.of({
        load: (name) =>
          sql<CheckpointRow>`
            SELECT position FROM ${sql(tables.checkpoints)} WHERE name = ${name}
          `.pipe(
            Effect.orDie,
            Effect.map((rows) => {
              const row = rows[0];
              return row === undefined ? 0n : toBigInt(row.position);
            }),
          ),
        save: (name, position) =>
          sql`
            INSERT INTO ${sql(tables.checkpoints)} (name, position)
            VALUES (${name}, ${position})
            ON CONFLICT (name) DO UPDATE SET position = excluded.position
          `.pipe(Effect.orDie, Effect.asVoid),
      });
    }),
  );
