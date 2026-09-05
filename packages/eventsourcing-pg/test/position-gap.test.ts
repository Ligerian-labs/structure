import { describe, expect, test } from "bun:test";
import * as SqlClient from "@effect/sql/SqlClient";
import { CheckpointStore, EventStore, Projection } from "@structure-ai/eventsourcing";
import { Chunk, Deferred, Effect, Fiber, Ref, Stream } from "effect";
import { layer, tableNames } from "../src/index.js";
import { counterRegistry, testMetadata } from "./fixtures.js";

const databaseUrl = process.env.DATABASE_URL;

/**
 * The position gap: `position` is drawn from a sequence at INSERT time,
 * inside the append transaction, so two concurrent appends can commit in
 * the opposite order of their positions. A projection polling in between
 * must never checkpoint past a position whose transaction has not
 * committed yet, or the late event is skipped for ever (it is committed,
 * visible to `read`, and delivered by a rebuild, but never by the live
 * projection).
 *
 * Two kinds of test defend the guarantee. The scripted ones drive one
 * interleaving deterministically through the REAL append path: writer A
 * appends inside an outer transaction that stays open until the test
 * releases it (the append becomes a savepoint of that transaction), writer
 * B appends concurrently from another fiber, the projection catches up
 * while A is still open, then A commits and the projection catches up
 * again. On a store with the defect, B commits at once and the first
 * catch-up checkpoints past A's positions; on a correct store the first
 * catch-up delivers nothing (B is queued behind A, or hidden from the
 * reader) and the second delivers everything in order. The load-based one
 * runs many writers at once against a reader that walks the feed and
 * refuses any jump: that is what pins WHERE the serialization sits (a lock
 * taken after the inserts passes the scripted tests and still gaps).
 */
const event = (version: number) => ({
  type: "Incremented",
  schemaVersion: 1,
  payload: { _tag: "Incremented", amount: version },
  metadata: testMetadata(version),
});

interface Outcome {
  readonly committed: ReadonlyArray<bigint>;
  readonly delivered: ReadonlyArray<bigint>;
  readonly checkpoint: bigint;
  readonly first: Projection.CatchupStats;
  readonly checkpointWhileOpen: bigint;
  readonly second: Projection.CatchupStats;
}

const positionsProjection = (name: string, seen: Ref.Ref<ReadonlyArray<bigint>>) =>
  Projection.make({
    name,
    registry: counterRegistry,
    when: {
      Incremented: (_event, stored) => Ref.update(seen, (list) => [...list, stored.position]),
    },
  });

/**
 * Waits until an event of `streamName` is visible to a fresh snapshot, or
 * until `millis` elapse. On a store with the defect B's row is visible
 * within milliseconds; on a correct store the wait runs out (B is queued or
 * hidden) and the scenario proceeds with B still pending.
 */
const awaitVisible = (streamName: string, eventsTable: string, millis: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const deadline = Date.now() + millis;
    while (Date.now() < deadline) {
      const rows = yield* sql<{ readonly n: number | string }>`
        SELECT count(*) AS n FROM ${sql(eventsTable)} WHERE stream_name = ${streamName}
      `;
      if (Number(rows[0]?.n ?? 0) > 0) return true;
      yield* Effect.sleep("25 millis");
    }
    return false;
  });

/**
 * A appends `aCount` events to `Counter-a` and holds its transaction open;
 * B appends one event to `Counter-b`; the projection catches up; A commits;
 * the projection catches up again.
 */
const interleave = (tablePrefix: string, aCount: number, projectionName: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* EventStore;
    const checkpoints = yield* CheckpointStore;
    const tables = tableNames({ tablePrefix });
    const seen = yield* Ref.make<ReadonlyArray<bigint>>([]);
    const projection = positionsProjection(projectionName, seen);

    const aAppended = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const a = yield* Effect.fork(
      sql.withTransaction(
        Effect.gen(function* () {
          const events = Array.from({ length: aCount }, (_, index) => event(index + 1));
          yield* store.append("Counter-a", 0, events);
          yield* Deferred.succeed(aAppended, undefined);
          yield* Deferred.await(release);
        }),
      ),
    );
    yield* Deferred.await(aAppended);

    const b = yield* Effect.fork(store.append("Counter-b", 0, [event(1)]));
    yield* awaitVisible("Counter-b", tables.events, 750);

    const first = yield* Projection.catchup(projection);
    const checkpointWhileOpen = yield* checkpoints.load(projectionName);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(a);
    yield* Fiber.join(b);
    const second = yield* Projection.catchup(projection);

    const rows = yield* sql<{ readonly position: number | string | bigint }>`
      SELECT position FROM ${sql(tables.events)} ORDER BY position ASC
    `;
    return {
      committed: rows.map((row) => BigInt(row.position)),
      delivered: yield* Ref.get(seen),
      checkpoint: yield* checkpoints.load(projectionName),
      first,
      checkpointWhileOpen,
      second,
    } satisfies Outcome;
  });

const withStores = <A, E>(
  body: (
    tablePrefix: string,
  ) => Effect.Effect<A, E, SqlClient.SqlClient | EventStore | CheckpointStore>,
): Promise<A> => {
  const tablePrefix = `gap${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}_`;
  const tables = tableNames({ tablePrefix });
  const dropTables = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const table of Object.values(tables)) {
      yield* sql`DROP TABLE IF EXISTS ${sql(table)}`;
    }
  }).pipe(Effect.orDie);
  return Effect.runPromise(
    body(tablePrefix).pipe(
      Effect.ensuring(dropTables),
      Effect.provide(
        layer(
          databaseUrl === undefined
            ? { tablePrefix, maxConnections: 20 }
            : { tablePrefix, url: databaseUrl, maxConnections: 20 },
        ),
      ),
    ),
  );
};

/** Nothing is checkpointed while A is open; then everything, once, in order. */
const expectGapFree = (outcome: Outcome, total: number) => {
  expect(outcome.committed).toEqual(Array.from({ length: total }, (_, i) => BigInt(i + 1)));
  expect(outcome.first.processed).toBe(0);
  expect(outcome.checkpointWhileOpen).toBe(0n);
  expect(outcome.delivered).toEqual(outcome.committed);
  expect(outcome.checkpoint).toBe(BigInt(total));
  expect(outcome.second.processed).toBe(total);
};

const SCENARIO_TIMEOUT = 15_000;

describe.skipIf(databaseUrl === undefined)("position gap (needs DATABASE_URL)", () => {
  test(
    "a single-event append that commits after a later position is still delivered",
    async () => {
      const outcome = await withStores((prefix) => interleave(prefix, 1, "gap-single"));
      expectGapFree(outcome, 2);
    },
    SCENARIO_TIMEOUT,
  );

  test(
    "a multi-event append that commits after a later position is delivered whole",
    async () => {
      const outcome = await withStores((prefix) => interleave(prefix, 2, "gap-multi"));
      expectGapFree(outcome, 3);
    },
    SCENARIO_TIMEOUT,
  );

  test(
    "a live catch-up and a rebuild from zero deliver the same positions",
    async () => {
      const outcome = await withStores((prefix) =>
        Effect.gen(function* () {
          const live = yield* interleave(prefix, 2, "gap-live");
          const rebuilt = yield* Ref.make<ReadonlyArray<bigint>>([]);
          const stats = yield* Projection.rebuild(
            positionsProjection("gap-rebuild", rebuilt),
            Effect.void,
          );
          return { live, rebuilt: yield* Ref.get(rebuilt), stats };
        }),
      );
      expectGapFree(outcome.live, 3);
      expect(outcome.rebuilt).toEqual(outcome.live.committed);
      expect(outcome.stats.processed).toBe(3);
    },
    SCENARIO_TIMEOUT,
  );

  // Pins WHERE the serialization sits: a systematic defect (no lock, a lock
  // taken after the inserts, a lock that covers only some writers) produces
  // about a hundred jumps per run here. A defect that fires on a small
  // fraction of appends can slip through one run; that is a soak's job, not
  // this test's.
  test("concurrent appends never leave a gap in the feed a reader walks", async () => {
    const writers = 12;
    const rounds = 40;
    const perAppend = 2;
    const total = writers * rounds * perAppend;
    const outcome = await withStores((prefix) =>
      Effect.gen(function* () {
        const store = yield* EventStore;
        const sql = yield* SqlClient.SqlClient;
        const tables = tableNames({ tablePrefix: prefix });

        // The reader polls the feed like a projection would (from the last
        // seen position, in batches) and records every batch that does not
        // continue contiguously from the previous one: a jump means a lower
        // position was still uncommitted when a higher one became visible.
        const jumps = yield* Ref.make<ReadonlyArray<string>>([]);
        const seen = yield* Ref.make(0n);
        const writersDone = yield* Deferred.make<void>();
        const reader = yield* Effect.fork(
          Effect.gen(function* () {
            while (true) {
              const from = (yield* Ref.get(seen)) + 1n;
              const batch = Chunk.toReadonlyArray(
                yield* Stream.runCollect(store.readAll({ fromPosition: from, batchSize: 50 })),
              );
              let expected = from;
              for (const stored of batch) {
                if (stored.position !== expected) {
                  yield* Ref.update(jumps, (list) => [
                    ...list,
                    `expected ${expected}, saw ${stored.position}`,
                  ]);
                }
                expected = stored.position + 1n;
              }
              const last = batch.at(-1);
              if (last !== undefined) yield* Ref.set(seen, last.position);
              if ((yield* Ref.get(seen)) >= BigInt(total)) return;
              if (batch.length === 0 && (yield* Deferred.isDone(writersDone))) return;
              if (batch.length === 0) yield* Effect.sleep("2 millis");
            }
          }),
        );

        yield* Effect.forEach(
          Array.from({ length: writers }, (_, writer) => writer),
          (writer) =>
            Effect.gen(function* () {
              let version = 0;
              for (let round = 0; round < rounds; round++) {
                const events = Array.from({ length: perAppend }, (_, i) => event(version + i + 1));
                yield* store.append(`Counter-w${writer}`, version, events);
                version += perAppend;
              }
            }),
          { concurrency: "unbounded", discard: true },
        );
        yield* Deferred.succeed(writersDone, undefined);
        yield* Fiber.join(reader);

        const rows = yield* sql<{ readonly n: number | string }>`
            SELECT count(*) AS n FROM ${sql(tables.events)}
          `;
        return {
          committed: Number(rows[0]?.n ?? 0),
          seen: yield* Ref.get(seen),
          jumps: yield* Ref.get(jumps),
        };
      }),
    );
    expect(outcome.committed).toBe(total);
    expect(outcome.jumps).toEqual([]);
    expect(outcome.seen).toBe(BigInt(total));
  }, 60_000);

  test(
    "a batched readAll returns positions in order whatever the heap order",
    async () => {
      const outcome = await withStores((prefix) =>
        Effect.gen(function* () {
          const store = yield* EventStore;
          const sql = yield* SqlClient.SqlClient;
          const tables = tableNames({ tablePrefix: prefix });
          yield* store.append("Counter-a", 0, [event(1), event(2), event(3)]);
          yield* store.append("Counter-b", 0, [event(1), event(2)]);
          // An UPDATE writes a new tuple version at the end of the heap, so a
          // scan without ORDER BY would now yield position 1 last.
          yield* sql`UPDATE ${sql(tables.events)} SET metadata = metadata WHERE position = 1`;
          const positions = (fromPosition: bigint, batchSize: number) =>
            Effect.map(Stream.runCollect(store.readAll({ fromPosition, batchSize })), (chunk) =>
              Chunk.toReadonlyArray(chunk).map((stored) => stored.position),
            );
          return {
            head: yield* positions(1n, 2),
            middle: yield* positions(2n, 3),
            all: yield* positions(1n, 10),
          };
        }),
      );
      expect(outcome.head).toEqual([1n, 2n]);
      expect(outcome.middle).toEqual([2n, 3n, 4n]);
      expect(outcome.all).toEqual([1n, 2n, 3n, 4n, 5n]);
    },
    SCENARIO_TIMEOUT,
  );

  // The steady state of a live store is a SPARSE feed: every rolled-back
  // append (a lost unique-constraint race, a caller transaction that aborts
  // after appending) burns the sequence value it drew. The feed must skip
  // such holes, never wait at them: a reader that cut at the first
  // non-contiguous position would wedge for ever.
  test(
    "the feed skips a position burned by a rolled-back append",
    async () => {
      const outcome = await withStores(() =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const store = yield* EventStore;
          const checkpoints = yield* CheckpointStore;
          yield* store.append("Counter-a", 0, [event(1)]);
          const aborted = yield* Effect.either(
            sql.withTransaction(
              Effect.gen(function* () {
                yield* store.append("Counter-b", 0, [event(1)]);
                return yield* Effect.fail("abort after appending");
              }),
            ),
          );
          yield* store.append("Counter-c", 0, [event(1)]);
          const seen = yield* Ref.make<ReadonlyArray<bigint>>([]);
          const stats = yield* Projection.catchup(positionsProjection("gap-sparse", seen), {
            batchSize: 1,
          });
          return {
            aborted: aborted._tag,
            feed: Chunk.toReadonlyArray(
              yield* Stream.runCollect(store.readAll({ fromPosition: 1n })),
            ).map((stored) => stored.position),
            delivered: yield* Ref.get(seen),
            checkpoint: yield* checkpoints.load("gap-sparse"),
            stats,
          };
        }),
      );
      expect(outcome.aborted).toBe("Left");
      expect(outcome.feed).toEqual([1n, 3n]);
      expect(outcome.delivered).toEqual([1n, 3n]);
      expect(outcome.checkpoint).toBe(3n);
      expect(outcome.stats).toEqual({ processed: 2, skipped: 0 });
    },
    SCENARIO_TIMEOUT,
  );
});
