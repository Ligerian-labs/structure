import { describe, expect, test } from "bun:test";
import { Chunk, Effect, Either, Stream } from "effect";
import { EventStore, InMemoryEventStore } from "../src/index.js";
import { testMetadata } from "./fixtures.js";

const event = (version: number, type = "Incremented") => ({
  type,
  schemaVersion: 1,
  payload: { _tag: type, amount: version },
  metadata: testMetadata(version),
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
        expect(result.left._tag).toBe("ConcurrencyConflict");
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
});
