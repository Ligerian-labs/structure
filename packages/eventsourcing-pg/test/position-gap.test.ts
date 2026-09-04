import { describe, expect, test } from "bun:test";
import * as SqlClient from "@effect/sql/SqlClient";
import { CheckpointStore, EventStore, Projection } from "@structure-ai/eventsourcing";
import { Deferred, Effect, Fiber, Ref } from "effect";
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
 * The interleaving is driven deterministically through the REAL append
 * path: writer A appends inside an outer transaction that stays open until
 * the test releases it (the append becomes a savepoint of that
 * transaction), writer B appends concurrently from another fiber, the
 * projection catches up while A is still open, then A commits and the
 * projection catches up again. Whatever the store does about it (block B
 * until A commits, or hide B's row from the reader while A is in flight),
 * every committed position must reach the projection exactly once, in
 * order.
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

/** Waits until B's event is visible to a fresh snapshot, or until `millis` elapse. */
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
    // On a store that lets B commit while A is open, B's row is visible within
    // milliseconds; on a store that queues B behind A, the wait times out and
    // the test proceeds with B still pending.
    yield* awaitVisible("Counter-b", tables.events, 3_000);

    const first = yield* Projection.catchup(projection);
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
            ? { tablePrefix, maxConnections: 8 }
            : { tablePrefix, url: databaseUrl, maxConnections: 8 },
        ),
      ),
    ),
  );
};

describe.skipIf(databaseUrl === undefined)("position gap (needs DATABASE_URL)", () => {
  test("a single-event append that commits after a later position is still delivered", async () => {
    const outcome = await withStores((prefix) => interleave(prefix, 1, "gap-single"));
    expect(outcome.committed).toEqual([1n, 2n, 3n].slice(0, outcome.committed.length));
    expect(outcome.committed.length).toBe(2);
    expect(outcome.delivered).toEqual(outcome.committed);
    expect(outcome.checkpoint).toBe(2n);
    expect(outcome.first.processed + outcome.second.processed).toBe(2);
  });

  test("a multi-event append that commits after a later position is delivered whole", async () => {
    const outcome = await withStores((prefix) => interleave(prefix, 2, "gap-multi"));
    expect(outcome.committed.length).toBe(3);
    expect(outcome.delivered).toEqual(outcome.committed);
    expect(outcome.checkpoint).toBe(3n);
    expect(outcome.first.processed + outcome.second.processed).toBe(3);
  });

  test("a live catch-up and a rebuild from zero deliver the same positions", async () => {
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
    expect(outcome.rebuilt).toEqual(outcome.live.committed);
    expect(outcome.live.delivered).toEqual(outcome.rebuilt);
    expect(outcome.stats.processed).toBe(outcome.live.committed.length);
  });
});
