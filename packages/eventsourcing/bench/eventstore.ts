import { strict as assert } from "node:assert";
import { Chunk, Effect, Stream } from "effect";
import { type AppendEvent, EventStore, InMemoryEventStore } from "../src/index.js";

// Fixed inputs keep UUID generation and clocks out of the append workload.
const count = Number(process.argv[2] ?? 10000);
const streamCount = Number(process.argv[3] ?? 100);
assert(Number.isSafeInteger(count) && count > 0, "event count must be a positive integer");
assert(
  Number.isSafeInteger(streamCount) && streamCount > 0 && streamCount <= count,
  "stream count must be a positive integer no greater than event count",
);
const events: ReadonlyArray<AppendEvent> = Array.from({ length: count }, (_, index) => ({
  type: "Incremented",
  schemaVersion: 1,
  payload: { amount: 1 },
  metadata: {
    eventId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    occurredAt: "2026-01-01T00:00:00.000Z",
    aggregateName: "Counter",
    aggregateId: String(index % streamCount),
    aggregateVersion: Math.floor(index / streamCount) + 1,
  },
}));

const program = Effect.gen(function* () {
  const store = yield* EventStore;
  const appendStart = performance.now();
  for (const event of events) {
    yield* store.append(
      `Counter-${event.metadata.aggregateId}`,
      event.metadata.aggregateVersion - 1,
      [event],
    );
  }
  const appendMs = performance.now() - appendStart;
  const readStart = performance.now();
  const stored = Chunk.toReadonlyArray(yield* Stream.runCollect(store.readAll()));
  const readMs = performance.now() - readStart;
  assert.equal(stored.length, count);
  for (const [index, event] of stored.entries()) {
    assert.equal(event.position, BigInt(index + 1));
    assert.equal(event.version, Math.floor(index / streamCount) + 1);
    assert.equal(event.streamName, `Counter-${index % streamCount}`);
    assert.deepEqual(event.payload, { amount: 1 });
  }
  const tail = Chunk.toReadonlyArray(
    yield* Stream.runCollect(store.readAll({ fromPosition: BigInt(count), batchSize: 1 })),
  );
  assert.equal(tail.length, 1);
  assert.equal(tail[0]?.position, BigInt(count));
  console.log(JSON.stringify({ count, streamCount, appendMs, readMs, checked: stored.length }));
});

await Effect.runPromise(program.pipe(Effect.provide(InMemoryEventStore)));
