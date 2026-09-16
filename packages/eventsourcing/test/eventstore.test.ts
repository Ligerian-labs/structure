import { describe, expect, test } from "bun:test";
import { ConcurrencyConflict } from "@structure-ai/domain";
import { Chunk, Effect, Either, Stream } from "effect";
import { EventStore, InMemoryEventStore, readAllPartitions } from "../src/index.js";
import { testMetadata } from "./fixtures.js";

const event = (version: number, type = "Incremented") => ({
  type,
  schemaVersion: 1,
  payload: { _tag: type, amount: version },
  metadata: testMetadata(version),
});

const partitioned = (version: number, partition: string) => ({
  ...event(version),
  metadata: { ...testMetadata(version), partition },
});

const collect = <A, E>(stream: Stream.Stream<A, E>) =>
  Effect.map(Stream.runCollect(stream), Chunk.toReadonlyArray);

describe("readAllPartitions", () => {
  test("no filter stays undefined; one value becomes a list; a list is deduplicated in order", () => {
    expect(readAllPartitions(undefined)).toBeUndefined();
    expect(readAllPartitions("a")).toEqual(["a"]);
    expect(readAllPartitions(["b", "a", "b", "a"])).toEqual(["b", "a"]);
    expect(readAllPartitions([])).toEqual([]);
  });
});

describe("InMemoryEventStore", () => {
  test("append/read roundtrip numbers versions from 1 and positions from 1", async () => {
    const program = Effect.gen(function* () {
      const store = yield* EventStore;
      const result = yield* store.append("Counter-a", 0, [event(1), event(2)]);
      expect(result).toEqual({ firstVersion: 1, lastVersion: 2 });
      const more = yield* store.append("Counter-a", 2, [event(3)]);
      expect(more).toEqual({ firstVersion: 3, lastVersion: 3 });
      const stored = Chunk.toReadonlyArray(yield* Stream.runCollect(store.read("Counter-a")));
      expect(stored.map((entry) => entry.version)).toEqual([1, 2, 3]);
      expect(stored.map((entry) => entry.position)).toEqual([1n, 2n, 3n]);
      expect(stored.map((entry) => entry.streamName)).toEqual([
        "Counter-a",
        "Counter-a",
        "Counter-a",
      ]);
      const fromVersion = Chunk.toReadonlyArray(
        yield* Stream.runCollect(store.read("Counter-a", { fromVersion: 3 })),
      );
      expect(fromVersion.map((entry) => entry.version)).toEqual([3]);
    });
    await Effect.runPromise(program.pipe(Effect.provide(InMemoryEventStore)));
  });

  test("expectedVersion mismatch fails with a populated ConcurrencyConflict", async () => {
    const program = Effect.gen(function* () {
      const store = yield* EventStore;
      yield* store.append("Counter-b", 0, [event(1), event(2)]);
      const result = yield* Effect.either(store.append("Counter-b", 0, [event(3)]));
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(ConcurrencyConflict);
        if (!(result.left instanceof ConcurrencyConflict)) throw new Error("expected conflict");
        expect(result.left.entity).toBe("Counter");
        expect(result.left.id).toBe("b");
        expect(result.left.expectedVersion).toBe(0);
        expect(result.left.actualVersion).toBe(2);
      }
    });
    await Effect.runPromise(program.pipe(Effect.provide(InMemoryEventStore)));
  });

  test("concurrent appends to the same stream: exactly one wins", async () => {
    const program = Effect.gen(function* () {
      const store = yield* EventStore;
      const results = yield* Effect.all(
        [
          Effect.either(store.append("Counter-c", 0, [event(1)])),
          Effect.either(store.append("Counter-c", 0, [event(1)])),
        ],
        { concurrency: "unbounded" },
      );
      const winners = results.filter(Either.isRight);
      const losers = results.filter(Either.isLeft);
      expect(winners.length).toBe(1);
      expect(losers.length).toBe(1);
      const stored = Chunk.toReadonlyArray(yield* Stream.runCollect(store.read("Counter-c")));
      expect(stored.length).toBe(1);
    });
    await Effect.runPromise(program.pipe(Effect.provide(InMemoryEventStore)));
  });

  test("readAll returns global order across streams and honors fromPosition/batchSize", async () => {
    const program = Effect.gen(function* () {
      const store = yield* EventStore;
      yield* store.append("Counter-x", 0, [event(1)]);
      yield* store.append("Counter-y", 0, [event(1)]);
      yield* store.append("Counter-x", 1, [event(2)]);
      const all = Chunk.toReadonlyArray(yield* Stream.runCollect(store.readAll()));
      expect(all.map((entry) => [entry.streamName, entry.position])).toEqual([
        ["Counter-x", 1n],
        ["Counter-y", 2n],
        ["Counter-x", 3n],
      ]);
      const tail = Chunk.toReadonlyArray(
        yield* Stream.runCollect(store.readAll({ fromPosition: 2n, batchSize: 1 })),
      );
      expect(tail.map((entry) => entry.position)).toEqual([2n]);
    });
    await Effect.runPromise(program.pipe(Effect.provide(InMemoryEventStore)));
  });

  test("readAll filters by envelope partition, keeping global order and paging", async () => {
    const program = Effect.gen(function* () {
      const store = yield* EventStore;
      yield* store.append("Counter-a1", 0, [partitioned(1, "a")]);
      yield* store.append("Counter-b1", 0, [partitioned(1, "b")]);
      yield* store.append("Counter-a1", 1, [partitioned(2, "a")]);
      yield* store.append("Counter-none", 0, [event(1)]);
      yield* store.append("Counter-b1", 1, [partitioned(2, "b")]);

      const onlyA = yield* collect(store.readAll({ partition: "a" }));
      expect(onlyA.map((entry) => [entry.streamName, entry.position])).toEqual([
        ["Counter-a1", 1n],
        ["Counter-a1", 3n],
      ]);
      const both = yield* collect(store.readAll({ partition: ["a", "b"] }));
      expect(both.map((entry) => entry.position)).toEqual([1n, 2n, 3n, 5n]);
      const all = yield* collect(store.readAll());
      expect(all.map((entry) => entry.position)).toEqual([1n, 2n, 3n, 4n, 5n]);
      const unknown = yield* collect(store.readAll({ partition: "zzz" }));
      expect(unknown).toEqual([]);
      const none = yield* collect(store.readAll({ partition: [] }));
      expect(none).toEqual([]);
      // paging composes with the filter: positions stay the global ones
      const page = yield* collect(
        store.readAll({ partition: "b", fromPosition: 3n, batchSize: 1 }),
      );
      expect(page.map((entry) => entry.position)).toEqual([5n]);
    });
    await Effect.runPromise(program.pipe(Effect.provide(InMemoryEventStore)));
  });

  test("readAll filtered by partition on an unpartitioned store yields nothing", async () => {
    const program = Effect.gen(function* () {
      const store = yield* EventStore;
      yield* store.append("Counter-p", 0, [event(1), event(2)]);
      expect(yield* collect(store.readAll({ partition: "a" }))).toEqual([]);
      expect((yield* collect(store.readAll())).length).toBe(2);
    });
    await Effect.runPromise(program.pipe(Effect.provide(InMemoryEventStore)));
  });

  test("collected reads are stable snapshots unaffected by later appends", async () => {
    const program = Effect.gen(function* () {
      const store = yield* EventStore;
      yield* store.append("Counter-s", 0, [event(1), event(2)]);
      const streamSnapshot = yield* collect(store.read("Counter-s"));
      const globalSnapshot = yield* collect(store.readAll());
      yield* store.append("Counter-s", 2, [event(3)]);
      yield* store.append("Counter-t", 0, [event(1)]);
      expect(streamSnapshot.map((entry) => entry.position)).toEqual([1n, 2n]);
      expect(globalSnapshot.map((entry) => entry.position)).toEqual([1n, 2n]);
      expect((yield* collect(store.read("Counter-s"))).map((entry) => entry.version)).toEqual([
        1, 2, 3,
      ]);
      expect((yield* collect(store.readAll())).map((entry) => entry.position)).toEqual([
        1n, 2n, 3n, 4n,
      ]);
    });
    await Effect.runPromise(program.pipe(Effect.provide(InMemoryEventStore)));
  });

  test("interleaved appends across streams keep contiguous positions and per-stream versions", async () => {
    const program = Effect.gen(function* () {
      const store = yield* EventStore;
      const order = ["Counter-i", "Counter-j", "Counter-i", "Counter-j", "Counter-i"] as const;
      const versions = [0, 0, 1, 1, 2] as const;
      for (const [index, stream] of order.entries()) {
        const result = yield* store.append(stream, versions[index], [event(index + 1)]);
        expect(result).toEqual({ firstVersion: versions[index] + 1, lastVersion: versions[index] + 1 });
      }
      const all = yield* collect(store.readAll());
      expect(all.map((entry) => entry.position)).toEqual([1n, 2n, 3n, 4n, 5n]);
      expect(all.map((entry) => entry.streamName)).toEqual([...order]);
      expect(all.map((entry) => entry.version)).toEqual([1, 1, 2, 2, 3]);
      expect((yield* collect(store.read("Counter-i"))).map((entry) => entry.version)).toEqual([
        1, 2, 3,
      ]);
      expect((yield* collect(store.read("Counter-j"))).map((entry) => entry.version)).toEqual([
        1, 2,
      ]);
    });
    await Effect.runPromise(program.pipe(Effect.provide(InMemoryEventStore)));
  });

  test("empty append at the current version reports the current version and stores nothing", async () => {
    const program = Effect.gen(function* () {
      const store = yield* EventStore;
      yield* store.append("Counter-e", 0, [event(1)]);
      const result = yield* store.append("Counter-e", 1, []);
      expect(result).toEqual({ firstVersion: 1, lastVersion: 1 });
      const emptyNewStream = yield* store.append("Counter-f", 0, []);
      expect(emptyNewStream).toEqual({ firstVersion: 0, lastVersion: 0 });
      expect((yield* collect(store.readAll())).map((entry) => entry.position)).toEqual([1n]);
    });
    await Effect.runPromise(program.pipe(Effect.provide(InMemoryEventStore)));
  });

  test("a conflicting append leaves stored events untouched", async () => {
    const program = Effect.gen(function* () {
      const store = yield* EventStore;
      yield* store.append("Counter-c1", 0, [event(1), event(2)]);
      yield* store.append("Counter-c2", 0, [event(1)]);
      const rejected = yield* Effect.either(store.append("Counter-c1", 0, [event(3)]));
      expect(Either.isLeft(rejected)).toBe(true);
      const all = yield* collect(store.readAll());
      expect(all.map((entry) => [entry.streamName, entry.version, entry.position])).toEqual([
        ["Counter-c1", 1, 1n],
        ["Counter-c1", 2, 2n],
        ["Counter-c2", 1, 3n],
      ]);
      const next = yield* store.append("Counter-c2", 1, [event(2)]);
      expect(next).toEqual({ firstVersion: 2, lastVersion: 2 });
      expect((yield* collect(store.readAll())).at(-1)?.position).toBe(4n);
    });
    await Effect.runPromise(program.pipe(Effect.provide(InMemoryEventStore)));
  });
});
