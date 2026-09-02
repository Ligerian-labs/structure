/**
 * Behavioral tests for the four Nisshi-backed ports against a live broker.
 * Skipped unless `NISSHI_URL` is set. Every test gets its own topic and its
 * own in-memory sidecar, so tests are order-independent.
 */

import { describe, expect, test } from "bun:test";
import * as SqlClient from "@effect/sql/SqlClient";
import type { SqlError } from "@effect/sql/SqlError";
import type { ConcurrencyConflict } from "@structure-ai/domain";
import {
  AggregateStore,
  CheckpointStore,
  EventStore,
  Inbox,
  SnapshotStore,
} from "@structure-ai/eventsourcing";
import { Cause, Chunk, Effect, type Layer, Option, Stream } from "effect";
import type { ConfigError } from "effect/ConfigError";
import type { NisshiConnectionError } from "../src/index.js";
import {
  drainPending,
  layer,
  type NisshiAdaptersConfig,
  NisshiProtocolError,
} from "../src/index.js";
import { Counter, counterRegistry, testMetadata } from "./fixtures.js";

const brokerUrl = process.env.NISSHI_URL ?? "";
const maybe = brokerUrl === "" ? describe.skip : describe;

const event = (version: number, amount = version) => ({
  type: "Incremented",
  schemaVersion: 1,
  payload: { _tag: "Incremented", amount },
  metadata: testMetadata(version),
});

type TestEnv = NisshiAdaptersConfig;
type Services =
  | EventStore
  | SnapshotStore
  | CheckpointStore
  | Inbox
  | SqlClient.SqlClient
  | import("../src/index.js").NisshiClient;
type BuildError = ConfigError | SqlError | NisshiConnectionError;

const env = (): TestEnv => ({
  brokerUrl,
  filename: ":memory:",
  topic: `events_${crypto.randomUUID().replaceAll("-", "_")}`,
});

const runWith = <A, E>(config: TestEnv, effect: Effect.Effect<A, E, Services>): Promise<A> =>
  Effect.runPromise(
    Effect.provide(
      effect,
      layer(config) as Layer.Layer<Services, BuildError, never>,
    ) as Effect.Effect<A, BuildError | E, never>,
  );

maybe("nisshi event store", () => {
  test("append assigns versions; read returns the stream in version order", async () => {
    const config = env();
    await runWith(
      config,
      Effect.gen(function* () {
        const store = yield* EventStore;
        const result = yield* store.append("Counter-1", 0, [event(1), event(2)]);
        expect(result).toEqual({ firstVersion: 1, lastVersion: 2 });
        yield* store.append("Counter-2", 0, [event(1)]);
        const stored = yield* Stream.runCollect(store.read("Counter-1"));
        expect(Chunk.toReadonlyArray(stored).map((e) => [e.version, e.type, e.payload])).toEqual([
          [1, "Incremented", { _tag: "Incremented", amount: 1 }],
          [2, "Incremented", { _tag: "Incremented", amount: 2 }],
        ]);
      }),
    );
  });

  test("append with a stale expectedVersion fails with ConcurrencyConflict", async () => {
    const config = env();
    await runWith(
      config,
      Effect.gen(function* () {
        const store = yield* EventStore;
        yield* store.append("Counter-1", 0, [event(1)]);
        const failure = yield* Effect.flip(store.append("Counter-1", 0, [event(1)]));
        expect(failure._tag).toBe("ConcurrencyConflict");
        const conflict = failure as ConcurrencyConflict;
        expect(conflict.entity).toBe("Counter");
        expect(conflict.id).toBe("1");
        expect(conflict.expectedVersion).toBe(0);
        expect(conflict.actualVersion).toBe(1);
        // nothing was written by the failed append
        const all = yield* Stream.runCollect(store.readAll());
        expect(Chunk.size(all)).toBe(1);
      }),
    );
  });

  test("empty append is a version-checked no-op", async () => {
    const config = env();
    await runWith(
      config,
      Effect.gen(function* () {
        const store = yield* EventStore;
        yield* store.append("Counter-1", 0, [event(1), event(2)]);
        const ok = yield* store.append("Counter-1", 2, []);
        expect(ok).toEqual({ firstVersion: 2, lastVersion: 2 });
        const stale = yield* Effect.flip(store.append("Counter-1", 1, []));
        expect((stale as ConcurrencyConflict).actualVersion).toBe(2);
      }),
    );
  });

  test("read filters by stream, honors fromVersion; missing stream is empty", async () => {
    const config = env();
    await runWith(
      config,
      Effect.gen(function* () {
        const store = yield* EventStore;
        yield* store.append("Counter-1", 0, [event(1), event(2), event(3)]);
        yield* store.append("Counter-2", 0, [event(1)]);
        const fromTwo = yield* Stream.runCollect(store.read("Counter-1", { fromVersion: 2 }));
        expect(Chunk.toReadonlyArray(fromTwo).map((e) => e.version)).toEqual([2, 3]);
        const missing = yield* Stream.runCollect(store.read("Counter-nope"));
        expect(Chunk.size(missing)).toBe(0);
      }),
    );
  });

  test("readAll yields global positions (offset + 1) and honors batchSize", async () => {
    const config = env();
    await runWith(
      config,
      Effect.gen(function* () {
        const store = yield* EventStore;
        yield* store.append("Counter-1", 0, [event(1), event(2)]);
        yield* store.append("Counter-2", 0, [event(1)]);
        const first = yield* Stream.runCollect(store.readAll({ batchSize: 2 }));
        const pageOne = Chunk.toReadonlyArray(first);
        expect(pageOne.map((e) => e.position)).toEqual([1n, 2n]);
        // callers poll again from the last seen position
        const rest = yield* Stream.runCollect(
          store.readAll({ fromPosition: (pageOne[1]?.position ?? 1n) + 1n }),
        );
        expect(Chunk.toReadonlyArray(rest).map((e) => e.streamName)).toEqual(["Counter-2"]);
        // everything from the start, unbatched
        const all = yield* Stream.runCollect(store.readAll());
        expect(Chunk.size(all)).toBe(3);
      }),
    );
  });

  test("AggregateStore executes commands and rehydrates from the topic", async () => {
    const config = env();
    await runWith(
      config,
      Effect.gen(function* () {
        const stores = yield* AggregateStore.make(Counter, counterRegistry, { snapshotEvery: 2 });
        const first = yield* stores.execute("1", { _tag: "Increment", amount: 3 });
        expect(first.state.total).toBe(3);
        const second = yield* stores.execute("1", { _tag: "Increment", amount: 4 });
        expect(second.state.total).toBe(7);
        expect(second.version).toBe(2);
        const rehydrated = yield* stores.load("1");
        expect(rehydrated.state.total).toBe(7);
      }),
    );
  });

  test("snapshots, checkpoints, and inbox behave like the sql adapters", async () => {
    const config = env();
    await runWith(
      config,
      Effect.gen(function* () {
        const snapshots = yield* SnapshotStore;
        expect(yield* snapshots.load("Counter-1")).toStrictEqual(Option.none());
        yield* snapshots.save("Counter-1", { state: { total: 5 }, version: 2 });
        yield* snapshots.save("Counter-1", { state: { total: 9 }, version: 4 });
        const snapshot = yield* snapshots.load("Counter-1");
        expect(Option.getOrThrow(snapshot)).toEqual({ state: { total: 9 }, version: 4 });

        const checkpoints = yield* CheckpointStore;
        expect(yield* checkpoints.load("projection")).toBe(0n);
        yield* checkpoints.save("projection", 4294967296n);
        expect(yield* checkpoints.load("projection")).toBe(4294967296n);

        const inbox = yield* Inbox;
        expect(yield* inbox.seen("c", "m1")).toBe(false);
        const result = yield* Inbox.dedupe("c", "m1")(Effect.succeed("done"));
        expect(Option.getOrThrow(result)).toBe("done");
        const duplicate = yield* Inbox.dedupe("c", "m1")(Effect.succeed("re-done"));
        expect(duplicate).toStrictEqual(Option.none());
      }),
    );
  });

  test("orphan relay publishes pending rows; readers dedupe by version", async () => {
    const config = env();
    await runWith(
      config,
      Effect.gen(function* () {
        const store = yield* EventStore;
        const sql = yield* SqlClient.SqlClient;
        yield* store.append("Counter-1", 0, [event(1)]);

        // Simulate a crash after reservation, before produce: a pending row
        // for version 2 plus a ledger bump, with nothing in the topic.
        const wire = {
          type: "Incremented",
          schemaVersion: 1,
          version: 2,
          payload: { _tag: "Incremented", amount: 2 },
          metadata: testMetadata(2),
        };
        yield* sql`UPDATE nisshi_streams SET last_version = 2 WHERE stream_name = 'Counter-1'`;
        yield* sql`INSERT INTO nisshi_pending (stream_name, version, topic, record_value)
                   VALUES ('Counter-1', 2, ${config.topic}, ${JSON.stringify(wire)})`;

        // While pending, reads reflect only committed events.
        let stored = yield* Stream.runCollect(store.read("Counter-1"));
        expect(Chunk.size(stored)).toBe(1);

        yield* drainPending();

        stored = yield* Stream.runCollect(store.read("Counter-1"));
        expect(Chunk.toReadonlyArray(stored).map((e) => e.version)).toEqual([1, 2]);
        const pending = yield* sql`SELECT COUNT(*) AS count FROM nisshi_pending`;
        expect(Number(pending[0]?.count)).toBe(0);

        // Re-draining is a no-op (no duplicate production path remains).
        yield* drainPending();
        stored = yield* Stream.runCollect(store.read("Counter-1"));
        expect(Chunk.size(stored)).toBe(2);
      }),
    );
  });

  test("client-side envelope validation rejects malformed events", async () => {
    const config = env();
    await runWith(
      config,
      Effect.gen(function* () {
        const store = yield* EventStore;
        const malformed = { ...event(1), type: "" };
        const exit = yield* Effect.exit(store.append("Counter-1", 0, [malformed]));
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          const defects = Chunk.toReadonlyArray(Cause.defects(exit.cause));
          expect(defects.some((d) => d instanceof NisshiProtocolError)).toBe(true);
          // nothing was reserved: a corrected append still succeeds at 0
          yield* store.append("Counter-1", 0, [event(1)]);
        }
      }),
    );
  });
});
