/**
 * The same behavioral contract as `nisshi.test.ts`, but with the sidecar on
 * PostgreSQL (via `layerPg`). Skipped unless BOTH `NISSHI_URL` (broker) and
 * `DATABASE_URL` (postgres) are set. Each test gets its own topic and its
 * own uniquely prefixed sidecar tables, dropped afterwards.
 */
import { describe, expect, test } from "bun:test";
import * as SqlClient from "@effect/sql/SqlClient";
import type { ConcurrencyConflict } from "@structure-ai/domain";
import {
  AggregateStore,
  CheckpointStore,
  EventStore,
  Inbox,
  SnapshotStore,
} from "@structure-ai/eventsourcing";
import { Chunk, Effect, type Layer, Option, Stream } from "effect";
import {
  drainPending,
  layerPg,
  type NisshiClient,
  type StoreServices,
  sidecarTables,
} from "../src/index.js";
import { Counter, counterRegistry, testMetadata } from "./fixtures.js";

const brokerUrl = process.env.NISSHI_URL ?? "";
const databaseUrl = process.env.DATABASE_URL ?? "";
const maybe = brokerUrl === "" || databaseUrl === "" ? describe.skip : describe;

const event = (version: number, amount = version) => ({
  type: "Incremented",
  schemaVersion: 1,
  payload: { _tag: "Incremented", amount },
  metadata: testMetadata(version),
});

type Services = StoreServices | SqlClient.SqlClient | NisshiClient;

type TestContext = {
  readonly tablePrefix: string;
  readonly topic: string;
  readonly tables: ReturnType<typeof sidecarTables>;
};

const runPg = <A, E>(body: (context: TestContext) => Effect.Effect<A, E, Services>): Promise<A> => {
  const tablePrefix = `t${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}_`;
  const topic = `events_${crypto.randomUUID().replaceAll("-", "_")}`;
  const tables = sidecarTables({ tablePrefix });
  const drop = Effect.orDie(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const table of [
        tables.streams,
        tables.pending,
        tables.snapshots,
        tables.checkpoints,
        tables.inbox,
      ]) {
        yield* sql`DROP TABLE IF EXISTS ${sql(table)}`;
      }
    }),
  );
  return Effect.runPromise(
    Effect.provide(
      body({ tablePrefix, topic, tables }).pipe(
        // drop runs inside the provided layer, while its sql client is open
        Effect.ensuring(drop),
      ) as Effect.Effect<A, E, Services>,
      layerPg({
        brokerUrl,
        url: databaseUrl,
        tablePrefix,
        topic,
      }) as Layer.Layer<Services, never, never>,
    ).pipe(Effect.scoped) as Effect.Effect<A, unknown, never>,
  );
};

maybe("nisshi adapters with postgres sidecar", () => {
  test("append/read round-trip with versions and positions", () =>
    runPg(() =>
      Effect.gen(function* () {
        const store = yield* EventStore;
        expect(yield* store.append("Counter-1", 0, [event(1), event(2)])).toEqual({
          firstVersion: 1,
          lastVersion: 2,
        });
        yield* store.append("Counter-2", 0, [event(1)]);
        const stored = yield* Stream.runCollect(store.read("Counter-1"));
        expect(Chunk.toReadonlyArray(stored).map((e) => [e.version, e.position])).toEqual([
          [1, 1n],
          [2, 2n],
        ]);
        const all = yield* Stream.runCollect(store.readAll({ batchSize: 2 }));
        expect(Chunk.size(all)).toBe(2);
        const rest = yield* Stream.runCollect(store.readAll({ fromPosition: 3n }));
        expect(Chunk.toReadonlyArray(rest).map((e) => e.streamName)).toEqual(["Counter-2"]);
      }),
    ));

  test("stale expectedVersion conflicts with the actual version", () =>
    runPg(() =>
      Effect.gen(function* () {
        const store = yield* EventStore;
        yield* store.append("Counter-1", 0, [event(1)]);
        const failure = yield* Effect.flip(store.append("Counter-1", 0, [event(1)]));
        const conflict = failure as ConcurrencyConflict;
        expect(conflict._tag).toBe("ConcurrencyConflict");
        expect(conflict.entity).toBe("Counter");
        expect(conflict.id).toBe("1");
        expect(conflict.actualVersion).toBe(1);
      }),
    ));

  test("AggregateStore round-trips commands through the pg-ledger CAS", () =>
    runPg(() =>
      Effect.gen(function* () {
        const stores = yield* AggregateStore.make(Counter, counterRegistry, { snapshotEvery: 2 });
        yield* stores.execute("1", { _tag: "Increment", amount: 3 });
        const second = yield* stores.execute("1", { _tag: "Increment", amount: 4 });
        expect(second.state.total).toBe(7);
        expect((yield* stores.load("1")).state.total).toBe(7);
      }),
    ));

  test("snapshots, checkpoints, and inbox on postgres", () =>
    runPg(() =>
      Effect.gen(function* () {
        const snapshots = yield* SnapshotStore;
        yield* snapshots.save("Counter-1", { state: { total: 9 }, version: 4 });
        expect(Option.getOrThrow(yield* snapshots.load("Counter-1"))).toEqual({
          state: { total: 9 },
          version: 4,
        });

        const checkpoints = yield* CheckpointStore;
        yield* checkpoints.save("projection", 4294967296n);
        expect(yield* checkpoints.load("projection")).toBe(4294967296n);

        const first = yield* Inbox.dedupe("c", "m1")(Effect.succeed("done"));
        expect(Option.getOrThrow(first)).toBe("done");
        expect(yield* Inbox.dedupe("c", "m1")(Effect.succeed("again"))).toStrictEqual(
          Option.none(),
        );
      }),
    ));

  test("orphan relay drains pg pending rows; readers dedupe", () =>
    runPg(({ tablePrefix, topic, tables }) =>
      Effect.gen(function* () {
        const store = yield* EventStore;
        const sql = yield* SqlClient.SqlClient;
        yield* store.append("Counter-1", 0, [event(1)]);
        const wire = {
          type: "Incremented",
          schemaVersion: 1,
          version: 2,
          payload: { _tag: "Incremented", amount: 2 },
          metadata: testMetadata(2),
        };
        yield* sql`UPDATE ${sql(tables.streams)} SET last_version = 2 WHERE stream_name = 'Counter-1'`;
        yield* sql`INSERT INTO ${sql(tables.pending)} (stream_name, version, topic, record_value)
                   VALUES ('Counter-1', 2, ${topic}, ${JSON.stringify(wire)})`;
        yield* drainPending({ tablePrefix });
        const stored = yield* Stream.runCollect(store.read("Counter-1"));
        expect(Chunk.toReadonlyArray(stored).map((e) => e.version)).toEqual([1, 2]);
      }),
    ));
});
