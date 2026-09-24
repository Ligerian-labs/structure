/**
 * Behavioral test suite shared by the sql adapters — the same scenarios as
 * the in-memory implementations in @structure-ai/eventsourcing (which are the
 * behavioral spec), plus the transactional-outbox and integration cases.
 *
 * NOTE: this file is intentionally duplicated between eventsourcing-sqlite
 * and eventsourcing-pg (no cross-package test imports); keep the copies in
 * sync.
 */
import { expect, test } from "bun:test";
import type * as SqlClient from "@effect/sql/SqlClient";
import { ConcurrencyConflict } from "@structure-ai/domain";
import {
  AggregateStore,
  CheckpointStore,
  EventStore,
  Inbox,
  Outbox,
  Projection,
  SnapshotStore,
  StreamEraser,
} from "@structure-ai/eventsourcing";
import { Chunk, Effect, Either, Option, Ref, Stream } from "effect";
import { type AdapterOptions, appendWithOutbox } from "../src/index.js";
import { Counter, counterRegistry, testMetadata } from "./fixtures.js";

/** Services a scenario may use: the ports plus the raw sql client. */
export type TestServices =
  | EventStore
  | SnapshotStore
  | CheckpointStore
  | Outbox
  | Inbox
  | StreamEraser
  | SqlClient.SqlClient;

/** One scenario, parameterized by the environment's adapter options. */
export type Scenario = (options?: AdapterOptions) => Effect.Effect<void, unknown, TestServices>;

/**
 * Runs one scenario against a FRESH, isolated environment (new database or
 * unique table set per call), passing it that environment's options.
 */
export type RunTest = (scenario: Scenario) => Promise<void>;

const event = (version: number, type = "Incremented") => ({
  type,
  schemaVersion: 1,
  payload: { _tag: type, amount: version },
  metadata: testMetadata(version),
});

const message = (id: string) => ({
  id,
  topic: "invoices",
  payload: { hello: "world" },
  metadata: { correlationId: "corr-1" },
});

/** Registers the full adapter suite with bun:test using `run` per scenario. */
export const registerScenarios = (run: RunTest): void => {
  test("append/read roundtrip numbers versions from 1 and positions from 1", () =>
    run(() =>
      Effect.gen(function* () {
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
        expect(stored.map((entry) => entry.type)).toEqual([
          "Incremented",
          "Incremented",
          "Incremented",
        ]);
        expect(stored[0]?.schemaVersion).toBe(1);
        expect(stored[0]?.payload).toEqual({ _tag: "Incremented", amount: 1 });
        expect(stored[0]?.metadata.aggregateName).toBe("Counter");
        const fromVersion = Chunk.toReadonlyArray(
          yield* Stream.runCollect(store.read("Counter-a", { fromVersion: 3 })),
        );
        expect(fromVersion.map((entry) => entry.version)).toEqual([3]);
        const missing = Chunk.toReadonlyArray(yield* Stream.runCollect(store.read("Counter-none")));
        expect(missing).toEqual([]);
      }),
    ));

  test("expectedVersion mismatch fails with a populated ConcurrencyConflict", () =>
    run(() =>
      Effect.gen(function* () {
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
        const stored = Chunk.toReadonlyArray(yield* Stream.runCollect(store.read("Counter-b")));
        expect(stored.length).toBe(2);
      }),
    ));

  test("empty append is a version-checked no-op", () =>
    run(() =>
      Effect.gen(function* () {
        const store = yield* EventStore;
        yield* store.append("Counter-e", 0, [event(1)]);
        const ok = yield* store.append("Counter-e", 1, []);
        expect(ok).toEqual({ firstVersion: 1, lastVersion: 1 });
        const bad = yield* Effect.either(store.append("Counter-e", 5, []));
        expect(Either.isLeft(bad)).toBe(true);
        const stored = Chunk.toReadonlyArray(yield* Stream.runCollect(store.read("Counter-e")));
        expect(stored.length).toBe(1);
      }),
    ));

  test("concurrent appends to the same stream: exactly one wins", () =>
    run(() =>
      Effect.gen(function* () {
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
        const loser = losers[0];
        if (loser !== undefined) {
          expect(loser.left._tag).toBe("ConcurrencyConflict");
        }
        const stored = Chunk.toReadonlyArray(yield* Stream.runCollect(store.read("Counter-c")));
        expect(stored.length).toBe(1);
      }),
    ));

  test("readAll returns global order across streams and honors fromPosition/batchSize", () =>
    run(() =>
      Effect.gen(function* () {
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
      }),
    ));

  test("readAll filters by envelope partition, keeping global order and paging", () =>
    run(() =>
      Effect.gen(function* () {
        const store = yield* EventStore;
        const partitioned = (version: number, partition: string) => ({
          ...event(version),
          metadata: { ...testMetadata(version), partition },
        });
        yield* store.append("Counter-a1", 0, [partitioned(1, "a")]);
        yield* store.append("Counter-b1", 0, [partitioned(1, "b")]);
        yield* store.append("Counter-a1", 1, [partitioned(2, "a")]);
        yield* store.append("Counter-none", 0, [event(1)]);
        yield* store.append("Counter-b1", 1, [partitioned(2, "b")]);

        const onlyA = Chunk.toReadonlyArray(
          yield* Stream.runCollect(store.readAll({ partition: "a" })),
        );
        expect(onlyA.map((entry) => [entry.streamName, entry.position])).toEqual([
          ["Counter-a1", 1n],
          ["Counter-a1", 3n],
        ]);
        const both = Chunk.toReadonlyArray(
          yield* Stream.runCollect(store.readAll({ partition: ["a", "b"] })),
        );
        expect(both.map((entry) => entry.position)).toEqual([1n, 2n, 3n, 5n]);
        const all = Chunk.toReadonlyArray(yield* Stream.runCollect(store.readAll()));
        expect(all.map((entry) => entry.position)).toEqual([1n, 2n, 3n, 4n, 5n]);
        expect(
          Chunk.toReadonlyArray(yield* Stream.runCollect(store.readAll({ partition: "zzz" }))),
        ).toEqual([]);
        expect(
          Chunk.toReadonlyArray(yield* Stream.runCollect(store.readAll({ partition: [] }))),
        ).toEqual([]);
        const page = Chunk.toReadonlyArray(
          yield* Stream.runCollect(
            store.readAll({ partition: "b", fromPosition: 3n, batchSize: 1 }),
          ),
        );
        expect(page.map((entry) => entry.position)).toEqual([5n]);
      }),
    ));

  test("readAll filtered by partition on an unpartitioned store yields nothing", () =>
    run(() =>
      Effect.gen(function* () {
        const store = yield* EventStore;
        yield* store.append("Counter-p", 0, [event(1), event(2)]);
        expect(
          Chunk.toReadonlyArray(yield* Stream.runCollect(store.readAll({ partition: "a" }))),
        ).toEqual([]);
        expect(Chunk.size(yield* Stream.runCollect(store.readAll()))).toBe(2);
      }),
    ));

  test("snapshot save/load roundtrip replaces previous snapshots", () =>
    run(() =>
      Effect.gen(function* () {
        const snapshots = yield* SnapshotStore;
        expect(Option.isNone(yield* snapshots.load("Counter-s"))).toBe(true);
        yield* snapshots.save("Counter-s", { state: { total: 5 }, version: 2 });
        const loaded = yield* snapshots.load("Counter-s");
        expect(Option.isSome(loaded)).toBe(true);
        if (Option.isSome(loaded)) {
          expect(loaded.value).toEqual({ state: { total: 5 }, version: 2 });
        }
        yield* snapshots.save("Counter-s", { state: { total: 9 }, version: 4 });
        const replaced = yield* snapshots.load("Counter-s");
        expect(Option.isSome(replaced)).toBe(true);
        if (Option.isSome(replaced)) {
          expect(replaced.value).toEqual({ state: { total: 9 }, version: 4 });
        }
      }),
    ));

  test("checkpoints: unseen consumers start at 0n, save overwrites", () =>
    run(() =>
      Effect.gen(function* () {
        const checkpoints = yield* CheckpointStore;
        expect(yield* checkpoints.load("nobody")).toBe(0n);
        yield* checkpoints.save("projector", 7n);
        expect(yield* checkpoints.load("projector")).toBe(7n);
        yield* checkpoints.save("projector", 9n);
        expect(yield* checkpoints.load("projector")).toBe(9n);
      }),
    ));

  test("outbox flow: enqueue → pending → markFailed/markPublished/markDead", () =>
    run(() =>
      Effect.gen(function* () {
        const outbox = yield* Outbox;
        yield* outbox.enqueue([message("m1"), message("m2"), message("m3")]);
        yield* outbox.enqueue([message("m1")]);
        const pending = yield* outbox.pending(10);
        expect(pending.map((entry) => entry.message.id)).toEqual(["m1", "m2", "m3"]);
        expect(pending.map((entry) => entry.status)).toEqual(["pending", "pending", "pending"]);
        expect(pending.map((entry) => entry.attempts)).toEqual([0, 0, 0]);
        expect(pending[0]?.message.topic).toBe("invoices");
        expect(pending[0]?.message.payload).toEqual({ hello: "world" });
        expect(pending[0]?.message.metadata).toEqual({ correlationId: "corr-1" });
        expect((yield* outbox.pending(2)).length).toBe(2);

        yield* outbox.markFailed("m2", "broker down", 1);
        const failed = (yield* outbox.pending(10)).find((entry) => entry.message.id === "m2");
        expect(failed?.status).toBe("pending");
        expect(failed?.attempts).toBe(1);
        expect(failed?.lastError).toBe("broker down");

        yield* outbox.markPublished(["m1", "m2"]);
        expect((yield* outbox.pending(10)).map((entry) => entry.message.id)).toEqual(["m3"]);

        yield* outbox.markDead("m3", "gave up");
        expect(yield* outbox.pending(10)).toEqual([]);
        const dead = yield* outbox.deadLetters();
        expect(dead.length).toBe(1);
        expect(dead[0]?.message.id).toBe("m3");
        expect(dead[0]?.status).toBe("dead");
        expect(dead[0]?.lastError).toBe("gave up");

        // Marking unknown ids is a no-op.
        yield* outbox.markPublished(["nope"]);
        yield* outbox.markFailed("nope", "x", 1);
        yield* outbox.markDead("nope", "x");
        expect((yield* outbox.deadLetters()).length).toBe(1);
      }),
    ));

  test("outbox scheduling: pending returns only due entries and preserves order", () =>
    run(() =>
      Effect.gen(function* () {
        const outbox = yield* Outbox;
        const now = Date.now();
        yield* outbox.enqueue([
          message("s1"),
          { ...message("s2"), availableAt: now + 60_000 },
          message("s3"),
        ]);
        expect((yield* outbox.pending(10)).map((entry) => entry.message.id)).toEqual(["s1", "s3"]);
        // The due filter respects the limit.
        expect((yield* outbox.pending(1)).map((entry) => entry.message.id)).toEqual(["s1"]);
        // Once due, the entry is offered — order still follows insertion.
        yield* outbox.markFailed("s2", "not yet", 0, now - 1);
        expect((yield* outbox.pending(10)).map((entry) => entry.message.id)).toEqual([
          "s1",
          "s2",
          "s3",
        ]);
        // A retryAt in the future hides the entry again (durable backoff).
        yield* outbox.markFailed("s2", "backing off", 1, now + 60_000);
        expect((yield* outbox.pending(10)).map((entry) => entry.message.id)).toEqual(["s1", "s3"]);
      }),
    ));

  test("outbox scheduling: markFailed without a retryAt keeps the entry due", () =>
    run(() =>
      Effect.gen(function* () {
        const outbox = yield* Outbox;
        yield* outbox.enqueue([{ ...message("d1"), availableAt: Date.now() + 60_000 }]);
        expect(yield* outbox.pending(10)).toEqual([]);
        // Clearing the schedule (no retryAt) makes the entry immediately due.
        yield* outbox.markFailed("d1", "schedule cleared", 1);
        const pending = yield* outbox.pending(10);
        expect(pending.map((entry) => entry.message.id)).toEqual(["d1"]);
        expect(pending[0]?.attempts).toBe(1);
        expect(pending[0]?.availableAt).toBeUndefined();
      }),
    ));

  test("outbox replay: dead letters return fresh and the schedule resets", () =>
    run(() =>
      Effect.gen(function* () {
        const outbox = yield* Outbox;
        const now = Date.now();
        yield* outbox.enqueue([message("p1"), { ...message("p2"), availableAt: now + 60_000 }]);
        yield* outbox.markFailed("p2", "scheduled", 2, now + 60_000);
        yield* outbox.markDead("p1", "gave up");
        yield* outbox.markDead("p2", "gave up too");
        // Unknown ids and non-dead entries are ignored.
        yield* outbox.replay(["missing"]);
        yield* outbox.enqueue([message("p3")]);
        yield* outbox.replay(["p3"]);
        expect((yield* outbox.deadLetters()).map((entry) => entry.message.id)).toEqual([
          "p1",
          "p2",
        ]);
        yield* outbox.replay(["p1", "p2"]);
        expect(yield* outbox.deadLetters()).toEqual([]);
        const pending = yield* outbox.pending(10);
        expect(pending.map((entry) => entry.message.id)).toEqual(["p1", "p2", "p3"]);
        for (const entry of pending) {
          expect(entry.attempts).toBe(0);
          expect(entry.lastError).toBeUndefined();
          expect(entry.availableAt).toBeUndefined();
        }
      }),
    ));

  test("inbox dedup: seen/markProcessed per consumer, idempotent", () =>
    run(() =>
      Effect.gen(function* () {
        const inbox = yield* Inbox;
        expect(yield* inbox.seen("billing", "msg-1")).toBe(false);
        yield* inbox.markProcessed("billing", "msg-1");
        expect(yield* inbox.seen("billing", "msg-1")).toBe(true);
        expect(yield* inbox.seen("shipping", "msg-1")).toBe(false);
        expect(yield* inbox.seen("billing", "msg-2")).toBe(false);
        yield* inbox.markProcessed("billing", "msg-1");
        expect(yield* inbox.seen("billing", "msg-1")).toBe(true);

        const runs = yield* Ref.make(0);
        const handler = Ref.update(runs, (n) => n + 1).pipe(Effect.as("handled"));
        const first = yield* Inbox.dedupe("billing", "msg-3")(handler);
        const second = yield* Inbox.dedupe("billing", "msg-3")(handler);
        expect(first).toEqual(Option.some("handled"));
        expect(Option.isNone(second)).toBe(true);
        expect(yield* Ref.get(runs)).toBe(1);
      }),
    ));

  test("appendWithOutbox stages events and messages in one transaction", () =>
    run((options) =>
      Effect.gen(function* () {
        const store = yield* EventStore;
        const outbox = yield* Outbox;
        const result = yield* appendWithOutbox(
          "Counter-w",
          0,
          [event(1), event(2)],
          [message("w1")],
          options,
        );
        expect(result).toEqual({ firstVersion: 1, lastVersion: 2 });
        const stored = Chunk.toReadonlyArray(yield* Stream.runCollect(store.read("Counter-w")));
        expect(stored.map((entry) => entry.version)).toEqual([1, 2]);
        const pending = yield* outbox.pending(10);
        expect(pending.map((entry) => entry.message.id)).toEqual(["w1"]);
      }),
    ));

  test("appendWithOutbox fails with ConcurrencyConflict and stages nothing", () =>
    run((options) =>
      Effect.gen(function* () {
        const store = yield* EventStore;
        const outbox = yield* Outbox;
        yield* store.append("Counter-k", 0, [event(1)]);
        const result = yield* Effect.either(
          appendWithOutbox("Counter-k", 0, [event(2)], [message("k1")], options),
        );
        expect(Either.isLeft(result)).toBe(true);
        if (Either.isLeft(result)) {
          expect(result.left).toBeInstanceOf(ConcurrencyConflict);
          if (!(result.left instanceof ConcurrencyConflict)) throw new Error("expected conflict");
          if (result.left._tag === "ConcurrencyConflict") {
            expect(result.left.actualVersion).toBe(1);
          }
        }
        const stored = Chunk.toReadonlyArray(yield* Stream.runCollect(store.read("Counter-k")));
        expect(stored.length).toBe(1);
        expect(yield* outbox.pending(10)).toEqual([]);
      }),
    ));

  test("appendWithOutbox is atomic: a failure after the event inserts rolls everything back", () =>
    run((options) =>
      Effect.gen(function* () {
        const store = yield* EventStore;
        const outbox = yield* Outbox;
        // A message with this id already exists, so inside the transaction
        // the outbox insert (after the event inserts) hits the primary key
        // and the whole transaction must roll back.
        yield* outbox.enqueue([message("dup")]);
        const result = yield* Effect.either(
          appendWithOutbox("Counter-z", 0, [event(1)], [message("fresh"), message("dup")], options),
        );
        expect(Either.isLeft(result)).toBe(true);
        if (Either.isLeft(result)) {
          expect(result.left._tag).toBe("SqlError");
        }
        const stored = Chunk.toReadonlyArray(yield* Stream.runCollect(store.read("Counter-z")));
        expect(stored).toEqual([]);
        const pending = yield* outbox.pending(10);
        expect(pending.map((entry) => entry.message.id)).toEqual(["dup"]);
      }),
    ));

  test("integration: AggregateStore and Projection catchup run on the sql adapters", () =>
    run(() =>
      Effect.gen(function* () {
        const counters = yield* AggregateStore.make(Counter, counterRegistry, {
          snapshotEvery: 2,
        });
        const first = yield* counters.execute("i1", { _tag: "Increment", amount: 2 });
        expect(first.state).toEqual({ total: 2 });
        expect(first.version).toBe(1);
        const second = yield* counters.execute(
          "i1",
          { _tag: "Increment", amount: 3 },
          { correlationId: "corr-9" },
        );
        expect(second.state).toEqual({ total: 5 });
        expect(second.version).toBe(2);
        expect(yield* counters.load("i1")).toEqual({ state: { total: 5 }, version: 2 });
        expect(yield* counters.load("nobody")).toEqual({ state: { total: 0 }, version: 0 });

        // The snapshot landed in the sql-backed SnapshotStore.
        const snapshots = yield* SnapshotStore;
        const snapshot = yield* snapshots.load("Counter-i1");
        expect(Option.isSome(snapshot)).toBe(true);
        if (Option.isSome(snapshot)) {
          expect(snapshot.value.version).toBe(2);
          expect(snapshot.value.state).toEqual({ total: 5 });
        }

        // Projection catchup over the sql-backed feed and checkpoints.
        const applied = yield* Ref.make<ReadonlyArray<string>>([]);
        const projection = Projection.make({
          name: "counter-totals",
          registry: counterRegistry,
          when: {
            Incremented: (incremented, stored) =>
              Ref.update(applied, (list) => [
                ...list,
                `${stored.streamName}@${stored.position}:${incremented.amount}`,
              ]),
          },
        });
        const stats = yield* Projection.catchup(projection, { batchSize: 1 });
        expect(stats).toEqual({ processed: 2, skipped: 0 });
        expect(yield* Ref.get(applied)).toEqual(["Counter-i1@1:2", "Counter-i1@2:3"]);
        const checkpoints = yield* CheckpointStore;
        expect(yield* checkpoints.load("counter-totals")).toBe(2n);

        // Resuming applies only new events.
        yield* counters.execute("i1", { _tag: "Increment", amount: 4 });
        const resumed = yield* Projection.catchup(projection);
        expect(resumed).toEqual({ processed: 1, skipped: 0 });
        expect((yield* Ref.get(applied)).length).toBe(3);
        expect(yield* checkpoints.load("counter-totals")).toBe(3n);
      }),
    ));
};

const erase = (streamName: string, expectedVersion: number, reason = "gdpr retention") =>
  Effect.flatMap(StreamEraser, (eraser) =>
    eraser.eraseStream({ streamName, expectedVersion, reason }),
  );

const stored = (streamName: string) =>
  Effect.flatMap(EventStore, (store) => Stream.runCollect(store.read(streamName))).pipe(
    Effect.map(Chunk.toReadonlyArray),
  );

/** Stream-erasure scenarios shared by the sql adapters (and mirroring the in-memory spec). */
export const registerStreamErasureScenarios = (run: RunTest): void => {
  test("eraseStream tombstones payloads and metadata, keeps positions and versions", () =>
    run(() =>
      Effect.gen(function* () {
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
      }),
    ));

  test("erased events are undecodable by the registry and the aggregate runtime", () =>
    run(() =>
      Effect.gen(function* () {
        const store = yield* EventStore;
        yield* store.append("Counter-b", 0, [event(1)]);
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
      }),
    ));

  test("eraseStream removes the stream's snapshot in the same operation", () =>
    run(() =>
      Effect.gen(function* () {
        const snapshots = yield* SnapshotStore;
        yield* snapshots.save("Counter-c", { state: { total: 9 }, version: 2 });
        yield* snapshots.save("Counter-other", { state: { total: 1 }, version: 1 });
        yield* erase("Counter-c", 0);
        expect(Option.isNone(yield* snapshots.load("Counter-c"))).toBe(true);
        const other = yield* snapshots.load("Counter-other");
        expect(Option.isSome(other)).toBe(true);
      }),
    ));

  test("readAll stays gap-free across erased and live streams; projections skip tombstones", () =>
    run(() =>
      Effect.gen(function* () {
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
      }),
    ));

  test("repeated erasure is idempotent and the stream stays pinned", () =>
    run(() =>
      Effect.gen(function* () {
        const store = yield* EventStore;
        yield* store.append("Counter-d", 0, [event(1), event(2)]);
        const first = yield* erase("Counter-d", 2, "first");
        expect(first.erasedEvents).toBe(2);
        const second = yield* erase("Counter-d", 2, "second");
        expect(second.erasedEvents).toBe(0);
        expect(second.lastVersion).toBe(2);
        expect(second.reason).toBe("first");

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
        if (Either.isLeft(conflict) && conflict.left._tag === "ConcurrencyConflict") {
          expect(conflict.left.actualVersion).toBe(2);
        }
      }),
    ));

  test("a stream that never existed is erased trivially and pinned empty", () =>
    run(() =>
      Effect.gen(function* () {
        const store = yield* EventStore;
        const result = yield* erase("Counter-none", 0);
        expect(result.erasedEvents).toBe(0);
        expect(result.lastVersion).toBe(0);
        const conflict = yield* Effect.either(store.append("Counter-none", 0, [event(1)]));
        expect(Either.isLeft(conflict)).toBe(true);
        if (Either.isLeft(conflict) && conflict.left._tag === "ConcurrencyConflict") {
          expect(conflict.left.actualVersion).toBe(0);
        }
      }),
    ));

  test("expectedVersion mismatch fails stream-modified and leaves the stream intact", () =>
    run(() =>
      Effect.gen(function* () {
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
      }),
    ));

  test("invalid requests fail before touching state", () =>
    run(() =>
      Effect.gen(function* () {
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
        const store = yield* EventStore;
        yield* store.append("Counter-f", 0, [event(1)]);
      }),
    ));

  test("concurrent append and erasure: exactly one wins", () =>
    run(() =>
      Effect.gen(function* () {
        const store = yield* EventStore;
        yield* store.append("Counter-race", 0, [event(1), event(2)]);
        const eraser = yield* StreamEraser;
        const results = yield* Effect.all(
          [
            Effect.either(store.append("Counter-race", 2, [event(3)])),
            Effect.either(
              eraser.eraseStream({
                streamName: "Counter-race",
                expectedVersion: 2,
                reason: "gdpr",
              }),
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
      }),
    ));
};
