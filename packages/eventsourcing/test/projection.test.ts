import { describe, expect, test } from "bun:test";
import { Effect, Layer, Ref } from "effect";
import {
  CheckpointStore,
  EventStore,
  InMemoryCheckpointStore,
  InMemoryEventStore,
  Projection,
} from "../src/index.js";
import { counterRegistry, testMetadata } from "./fixtures.js";

const layer = Layer.mergeAll(InMemoryEventStore, InMemoryCheckpointStore);

const incremented = (amount: number) => ({
  type: "Incremented",
  schemaVersion: 1,
  payload: { _tag: "Incremented", amount },
  metadata: testMetadata(amount),
});

describe("Projection", () => {
  test("catchup applies in global order, checkpoints, resumes idempotently, rebuild replays with live:false", async () => {
    const program = Effect.gen(function* () {
      const applied = yield* Ref.make<ReadonlyArray<string>>([]);
      const lives = yield* Ref.make<ReadonlyArray<boolean>>([]);
      const projection = Projection.make({
        name: "counter-totals",
        registry: counterRegistry,
        when: {
          Incremented: (event, stored, context) =>
            Effect.gen(function* () {
              yield* Ref.update(applied, (list) => [
                ...list,
                `${stored.streamName}@${stored.position}:${event.amount}`,
              ]);
              yield* Ref.update(lives, (list) => [...list, context.live]);
            }),
        },
      });

      const store = yield* EventStore;
      yield* store.append("Counter-p1", 0, [incremented(1)]);
      yield* store.append("Counter-p2", 0, [incremented(2)]);
      yield* store.append("Counter-p1", 1, [incremented(3)]);

      // First catchup: everything, in global order, live.
      const first = yield* Projection.catchup(projection, { batchSize: 2 });
      expect(first).toEqual({ processed: 3, skipped: 0 });
      expect(yield* Ref.get(applied)).toEqual([
        "Counter-p1@1:1",
        "Counter-p2@2:2",
        "Counter-p1@3:3",
      ]);
      expect(yield* Ref.get(lives)).toEqual([true, true, true]);
      const checkpoints = yield* CheckpointStore;
      expect(yield* checkpoints.load("counter-totals")).toBe(3n);

      // Re-running applies nothing (checkpoint prevents re-delivery).
      const again = yield* Projection.catchup(projection);
      expect(again).toEqual({ processed: 0, skipped: 0 });
      expect((yield* Ref.get(applied)).length).toBe(3);

      // New events are picked up from the checkpoint.
      yield* store.append("Counter-p2", 1, [incremented(4)]);
      const resumed = yield* Projection.catchup(projection);
      expect(resumed).toEqual({ processed: 1, skipped: 0 });
      expect((yield* Ref.get(applied)).length).toBe(4);
      expect(yield* checkpoints.load("counter-totals")).toBe(4n);

      // Rebuild: reset, zero the checkpoint, replay everything with live:false.
      yield* Ref.set(lives, []);
      const rebuilt = yield* Projection.rebuild(projection, Ref.set(applied, []));
      expect(rebuilt).toEqual({ processed: 4, skipped: 0 });
      expect((yield* Ref.get(applied)).length).toBe(4);
      expect(yield* Ref.get(lives)).toEqual([false, false, false, false]);
      expect(yield* checkpoints.load("counter-totals")).toBe(4n);
    });
    await Effect.runPromise(program.pipe(Effect.provide(layer)));
  });

  test("events with a type unknown to the registry are skipped and counted", async () => {
    const program = Effect.gen(function* () {
      const applied = yield* Ref.make(0);
      const projection = Projection.make({
        name: "skipper",
        registry: counterRegistry,
        when: {
          Incremented: () => Ref.update(applied, (n) => n + 1),
        },
      });
      const store = yield* EventStore;
      yield* store.append("Counter-s1", 0, [
        incremented(1),
        { type: "LegacyThing", schemaVersion: 1, payload: {}, metadata: testMetadata(2) },
        incremented(3),
      ]);
      const stats = yield* Projection.catchup(projection);
      expect(stats).toEqual({ processed: 2, skipped: 1 });
      expect(yield* Ref.get(applied)).toBe(2);
      const checkpoints = yield* CheckpointStore;
      expect(yield* checkpoints.load("skipper")).toBe(3n);
    });
    await Effect.runPromise(program.pipe(Effect.provide(layer)));
  });
});
