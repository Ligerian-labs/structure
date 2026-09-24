import { describe, expect, test } from "bun:test";
import { Chunk, Effect, Either, Option, Ref, Stream } from "effect";
import {
  AggregateStore,
  CheckpointStore,
  EventStore,
  InMemoryAll,
  Projection,
  SnapshotStore,
  StreamEraser,
} from "../src/index.js";
import { Counter, counterRegistry, testMetadata } from "./fixtures.js";

const event = (version: number, type = "Incremented") => ({
  type,
  schemaVersion: 1,
  payload: { _tag: type, amount: version },
  metadata: testMetadata(version),
});

const erase = (streamName: string, expectedVersion: number, reason = "gdpr retention") =>
  Effect.flatMap(StreamEraser, (eraser) =>
    eraser.eraseStream({ streamName, expectedVersion, reason }),
  );

const stored = (streamName: string) =>
  Effect.flatMap(EventStore, (store) => Stream.runCollect(store.read(streamName))).pipe(
    Effect.map(Chunk.toReadonlyArray),
  );

describe("stream erasure (in-memory)", () => {
  test("eraseStream tombstones payloads and metadata, keeps positions and versions", async () => {
    const program = Effect.gen(function* () {
      const store = yield* EventStore;
      yield* store.append("Counter-a", 0, [event(1), event(2)]);
      const result = yield* erase("Counter-a", 2);
      expect(result.erasedEvents).toBe(2);
      expect(result.lastVersion).toBe(2);
      expect(typeof result.erasedAt).toBe("string");

      const after = yield* stored("Counter-a");
      expect(after.map((entry) => entry.version)).toEqual([1, 2]);
      expect(after.map((entry) => entry.position)).toEqual([1n, 2n]);
      for (const entry of after) {
        expect(entry.type).toBe("Erased");
        expect(entry.payload).toEqual({ _tag: "Erased" });
        expect(entry.metadata.eventId).toBe(`erased:Counter-a:${entry.version}`);
        expect(entry.metadata.aggregateName).toBe("Counter");
        expect(entry.metadata.aggregateId).toBe("a");
        expect(entry.metadata.aggregateVersion).toBe(entry.version);
        expect(entry.metadata.occurredAt).toBe(result.erasedAt);
        expect(entry.metadata.correlationId).toBeUndefined();
        expect(entry.metadata.causationId).toBeUndefined();
        expect(entry.metadata.actor).toBeUndefined();
      }
      const feed = Chunk.toReadonlyArray(yield* Stream.runCollect(store.readAll()));
      expect(feed.map((entry) => entry.position)).toEqual([1n, 2n]);
      expect(feed.every((entry) => entry.type === "Erased")).toBe(true);
    });
    await Effect.runPromise(program.pipe(Effect.provide(InMemoryAll)));
  });

  test("erased events are undecodable by registries and aggregates", async () => {
    const program = Effect.gen(function* () {
      yield* EventStore;
      yield* Effect.flatMap(EventStore, (store) => store.append("Counter-b", 0, [event(1)]));
      yield* erase("Counter-b", 1);
      const after = yield* stored("Counter-b");
      const decoded = yield* Effect.either(counterRegistry.decode(after[0] as never));
      expect(Either.isLeft(decoded)).toBe(true);
      if (Either.isLeft(decoded)) {
        expect(decoded.left._tag).toBe("EventDecodeError");
        expect(decoded.left.reason).toContain("unknown event type");
      }
      const counters = yield* AggregateStore.make(Counter, counterRegistry);
      const loaded = yield* Effect.either(counters.load("b"));
      expect(Either.isLeft(loaded)).toBe(true);
      if (Either.isLeft(loaded)) {
        expect(loaded.left._tag).toBe("EventDecodeError");
      }
    });
    await Effect.runPromise(program.pipe(Effect.provide(InMemoryAll)));
  });

  test("eraseStream removes the stream's snapshot in the same operation", async () => {
    const program = Effect.gen(function* () {
      const snapshots = yield* SnapshotStore;
      yield* snapshots.save("Counter-c", { state: { total: 9 }, version: 2 });
      yield* snapshots.save("Counter-other", { state: { total: 1 }, version: 1 });
      yield* erase("Counter-c", 0);
      expect(Option.isNone(yield* snapshots.load("Counter-c"))).toBe(true);
      const other = yield* snapshots.load("Counter-other");
      expect(Option.isSome(other)).toBe(true);
    });
    await Effect.runPromise(program.pipe(Effect.provide(InMemoryAll)));
  });

  test("readAll keeps gap-free global order across erased and live streams; projections skip tombstones", async () => {
    const program = Effect.gen(function* () {
      const store = yield* EventStore;
      yield* store.append("Counter-x", 0, [event(1)]);
      yield* store.append("Counter-y", 0, [event(1)]);
      yield* store.append("Counter-x", 1, [event(2)]);
      yield* erase("Counter-x", 2);

      const feed = Chunk.toReadonlyArray(yield* Stream.runCollect(store.readAll()));
      expect(feed.map((entry) => [entry.position, entry.type])).toEqual([
        [1n, "Erased"],
        [2n, "Incremented"],
        [3n, "Erased"],
      ]);
      expect(feed[2]?.payload).toEqual({ _tag: "Erased" });

      const applied = yield* Ref.make<ReadonlyArray<string>>([]);
      const projection = Projection.make({
        name: "erasure-projection",
        registry: counterRegistry,
        when: {
          Incremented: (_incremented, entry) =>
            Ref.update(applied, (list) => [...list, `${entry.streamName}@${entry.position}`]),
        },
      });
      const stats = yield* Projection.catchup(projection);
      expect(stats).toEqual({ processed: 1, skipped: 2 });
      expect(yield* Ref.get(applied)).toEqual(["Counter-y@2"]);
      const checkpoints = yield* CheckpointStore;
      expect(yield* checkpoints.load("erasure-projection")).toBe(3n);
    });
    await Effect.runPromise(program.pipe(Effect.provide(InMemoryAll)));
  });

  test("repeated erasure is idempotent: no events rewritten, ledger refreshed, stream stays pinned", async () => {
    const program = Effect.gen(function* () {
      const store = yield* EventStore;
      yield* store.append("Counter-d", 0, [event(1), event(2)]);
      const first = yield* erase("Counter-d", 2, "first");
      expect(first.erasedEvents).toBe(2);
      const second = yield* erase("Counter-d", 2, "second");
      expect(second.erasedEvents).toBe(0);
      expect(second.lastVersion).toBe(2);

      const after = yield* stored("Counter-d");
      expect(after.map((entry) => entry.metadata.eventId)).toEqual([
        "erased:Counter-d:1",
        "erased:Counter-d:2",
      ]);
      expect(after.map((entry) => entry.metadata.occurredAt)).toEqual([
        first.erasedAt,
        first.erasedAt,
      ]);
      const conflict = yield* Effect.either(store.append("Counter-d", 2, [event(3)]));
      expect(Either.isLeft(conflict)).toBe(true);
      if (Either.isLeft(conflict)) {
        expect(conflict.left._tag).toBe("ConcurrencyConflict");
        if (conflict.left._tag === "ConcurrencyConflict") {
          expect(conflict.left.actualVersion).toBe(2);
        }
      }
    });
    await Effect.runPromise(program.pipe(Effect.provide(InMemoryAll)));
  });

  test("a stream that never existed is erased trivially and pinned empty", async () => {
    const program = Effect.gen(function* () {
      const store = yield* EventStore;
      const result = yield* erase("Counter-none", 0);
      expect(result.erasedEvents).toBe(0);
      expect(result.lastVersion).toBe(0);
      const conflict = yield* Effect.either(store.append("Counter-none", 0, [event(1)]));
      expect(Either.isLeft(conflict)).toBe(true);
      if (Either.isLeft(conflict) && conflict.left._tag === "ConcurrencyConflict") {
        expect(conflict.left.actualVersion).toBe(0);
      }
    });
    await Effect.runPromise(program.pipe(Effect.provide(InMemoryAll)));
  });

  test("expectedVersion mismatch fails with stream-modified and leaves the stream intact", async () => {
    const program = Effect.gen(function* () {
      const store = yield* EventStore;
      yield* store.append("Counter-e", 0, [event(1), event(2)]);
      const result = yield* Effect.either(erase("Counter-e", 1));
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result) && result.left._tag === "StreamErasureError") {
        expect(result.left.reason).toBe("stream-modified");
        expect(result.left.classification).toBe("conflict");
        expect(result.left.detail).toContain("Counter-e");
      }
      const after = yield* stored("Counter-e");
      expect(after.map((entry) => entry.type)).toEqual(["Incremented", "Incremented"]);
      expect(after[0]?.payload).toEqual({ _tag: "Incremented", amount: 1 });
    });
    await Effect.runPromise(program.pipe(Effect.provide(InMemoryAll)));
  });

  test("invalid requests fail before touching state", async () => {
    const program = Effect.gen(function* () {
      const eraser = yield* StreamEraser;
      const cases: ReadonlyArray<{
        streamName: string;
        expectedVersion: number;
        reason: string;
      }> = [
        { streamName: "  ", expectedVersion: 0, reason: "gdpr" },
        { streamName: "Counter-f", expectedVersion: -1, reason: "gdpr" },
        { streamName: "Counter-f", expectedVersion: 1.5, reason: "gdpr" },
        { streamName: "Counter-f", expectedVersion: 0, reason: "" },
      ];
      for (const request of cases) {
        const result = yield* Effect.either(eraser.eraseStream(request));
        expect(Either.isLeft(result)).toBe(true);
        if (Either.isLeft(result) && result.left._tag === "StreamErasureError") {
          expect(result.left.reason).toBe("invalid-request");
          expect(result.left.classification).toBe("permanent");
        }
      }
      // Nothing was pinned: the stream is still writable.
      const store = yield* EventStore;
      yield* store.append("Counter-f", 0, [event(1)]);
    });
    await Effect.runPromise(program.pipe(Effect.provide(InMemoryAll)));
  });

  test("concurrent append and erasure: exactly one wins", async () => {
    const program = Effect.gen(function* () {
      const store = yield* EventStore;
      yield* store.append("Counter-race", 0, [event(1), event(2)]);
      const eraser = yield* StreamEraser;
      const results = yield* Effect.all(
        [
          Effect.either(store.append("Counter-race", 2, [event(3)])),
          Effect.either(
            eraser.eraseStream({ streamName: "Counter-race", expectedVersion: 2, reason: "gdpr" }),
          ),
        ],
        { concurrency: "unbounded" },
      );
      const winners = results.filter((result) => result._tag === "Right");
      expect(winners.length).toBe(1);
      const after = yield* stored("Counter-race");
      const appendWon = results[0]?._tag === "Right";
      if (appendWon) {
        expect(after.map((entry) => entry.type)).toEqual([
          "Incremented",
          "Incremented",
          "Incremented",
        ]);
      } else {
        expect(after.every((entry) => entry.type === "Erased")).toBe(true);
      }
    });
    await Effect.runPromise(program.pipe(Effect.provide(InMemoryAll)));
  });
});
