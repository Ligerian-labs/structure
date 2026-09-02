import { DynamoDBDocumentService } from "@effect-aws/dynamodb";
import { CheckpointStore, type Snapshot, SnapshotStore } from "@structure-ai/eventsourcing";
import { Effect, Layer, Option } from "effect";
import { dynamoError } from "./internal.js";
import {
  type AdapterOptions,
  checkpointPk,
  checkpointSk,
  ENTITY,
  PK,
  POSITION,
  SK,
  snapshotSk,
  streamPk,
  tableName,
  VERSION,
} from "./schema.js";
import { positionToUlid, ulidToPosition } from "./ulid.js";

/** `SnapshotStore` keeping the latest snapshot per stream as one item. */
export const snapshotStoreLayer = (
  options?: AdapterOptions,
): Layer.Layer<SnapshotStore, never, DynamoDBDocumentService> =>
  Layer.effect(
    SnapshotStore,
    Effect.gen(function* () {
      const ddb = yield* DynamoDBDocumentService;
      const table = tableName(options);
      return SnapshotStore.of({
        load: (streamName) =>
          ddb
            .get({
              TableName: table,
              Key: { [PK]: streamPk(streamName), [SK]: snapshotSk },
              ConsistentRead: true,
            })
            .pipe(
              Effect.map((output) => {
                const item = output.Item as { state?: unknown; [VERSION]?: unknown } | undefined;
                return item === undefined
                  ? Option.none<Snapshot>()
                  : Option.some<Snapshot>({
                      state: item.state,
                      version: typeof item[VERSION] === "number" ? (item[VERSION] as number) : 0,
                    });
              }),
              Effect.catchAll((error) => Effect.die(dynamoError(error))),
            ),
        save: (streamName, snapshot) =>
          ddb
            .put({
              TableName: table,
              Item: {
                [PK]: streamPk(streamName),
                [SK]: snapshotSk,
                [ENTITY]: "snapshot",
                [VERSION]: snapshot.version,
                state: snapshot.state,
              },
            })
            .pipe(
              Effect.asVoid,
              Effect.catchAll((error) => Effect.die(dynamoError(error))),
            ),
      });
    }),
  );

/** `CheckpointStore` persisting consumer positions as ULID strings. */
export const checkpointStoreLayer = (
  options?: AdapterOptions,
): Layer.Layer<CheckpointStore, never, DynamoDBDocumentService> =>
  Layer.effect(
    CheckpointStore,
    Effect.gen(function* () {
      const ddb = yield* DynamoDBDocumentService;
      const table = tableName(options);
      return CheckpointStore.of({
        load: (name) =>
          ddb
            .get({
              TableName: table,
              Key: { [PK]: checkpointPk(name), [SK]: checkpointSk },
              ConsistentRead: true,
            })
            .pipe(
              Effect.map((output) => {
                const item = output.Item as { [POSITION]?: unknown } | undefined;
                return typeof item?.[POSITION] === "string" ? ulidToPosition(item[POSITION]) : 0n;
              }),
              Effect.catchAll((error) => Effect.die(dynamoError(error))),
            ),
        save: (name, position) =>
          ddb
            .put({
              TableName: table,
              Item: {
                [PK]: checkpointPk(name),
                [SK]: checkpointSk,
                [ENTITY]: "checkpoint",
                [POSITION]: positionToUlid(position),
              },
            })
            .pipe(
              Effect.asVoid,
              Effect.catchAll((error) => Effect.die(dynamoError(error))),
            ),
      });
    }),
  );
