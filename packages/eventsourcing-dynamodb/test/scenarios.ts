/**
 * Behavioral test suite for the DynamoDB adapter — the same scenarios as
 * the sql adapters (duplicated per the repo's no-cross-package-test-imports
 * convention), adapted where the single-table semantics differ:
 *
 * - positions are ULIDs mapped to bigint: strictly increasing per write,
 *   not contiguous integers;
 * - `readAll` and outbox `pending`/`deadLetters` query GSIs, which are
 *   eventually consistent — assertions poll with `waitFor` instead of
 *   reading once;
 * - the transactional-atomicity case surfaces a duplicate outbox id as a
 *   defect (DynamoDB has no partial-failure error channel).
 */
import { expect, test } from "bun:test";
import type { DynamoDBDocumentService } from "@effect-aws/dynamodb";
import {
  AggregateStore,
  CheckpointStore,
  EventStore,
  Inbox,
  Outbox,
  Projection,
  SnapshotStore,
} from "@structure-ai/eventsourcing";
import { Chunk, Effect, Either, Option, Ref, Stream } from "effect";
import { type AdapterOptions, appendWithOutbox } from "../src/index.js";
import { Counter, counterRegistry, testMetadata } from "./fixtures.js";

/** Services a scenario may use: the five ports plus the document client. */
export type TestServices =
  | EventStore
  | SnapshotStore
  | CheckpointStore
  | Outbox
  | Inbox
  | DynamoDBDocumentService;

/** One scenario, parameterized by the environment's adapter options. */
export type Scenario = (options?: AdapterOptions) => Effect.Effect<void, unknown, TestServices>;

/**
 * Runs one scenario against a FRESH, isolated environment (a unique table
 * name per call), passing it that environment's options.
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

/** Retries an effect until its result satisfies `predicate` (GSI lag). */
const waitFor = <A>(
  effect: Effect.Effect<A, unknown, TestServices>,
  predicate: (value: A) => boolean,
  remainingMs = 5000,
): Effect.Effect<A, unknown, TestServices> =>
  Effect.flatMap(effect, (value) =>
    predicate(value)
      ? Effect.succeed(value)
      : remainingMs <= 0
        ? Effect.fail(
            new Error(
              `waitFor: condition not met within the timeout (GSI lag or behavioral break)`,
            ),
          )
        : Effect.sleep("100 millis").pipe(
            Effect.andThen(waitFor(effect, predicate, remainingMs - 100)),
          ),
  );

/** Registers the full adapter suite with bun:test using `run` per scenario. */
export const registerScenarios = (run: RunTest): void => {
  test("append/read roundtrip numbers versions from 1; positions increase", () =>
    run(() =>
      Effect.gen(function* () {
        const store = yield* EventStore;
        const result = yield* store.append("Counter-a", 0, [event(1), event(2)]);
        expect(result).toEqual({ firstVersion: 1, lastVersion: 2 });
        const more = yield* store.append("Counter-a", 2, [event(3)]);
        expect(more).toEqual({ firstVersion: 3, lastVersion: 3 });
        const stored = Chunk.toReadonlyArray(yield* Stream.runCollect(store.read("Counter-a")));
        expect(stored.map((entry) => entry.version)).toEqual([1, 2, 3]);
        const positions = stored.map((entry) => entry.position);
        const [first, second, third] = positions;
        expect(first !== undefined && second !== undefined && first < second).toBe(true);
        expect(second !== undefined && third !== undefined && second < third).toBe(true);
        expect(first !== undefined && first > 0n).toBe(true);
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
          expect(result.left._tag).toBe("ConcurrencyConflict");
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
        const all = Chunk.toReadonlyArray(
          yield* waitFor(Stream.runCollect(store.readAll()), (chunk) => Chunk.size(chunk) === 3),
        );
        expect(all.map((entry) => entry.streamName)).toEqual([
          "Counter-x",
          "Counter-y",
          "Counter-x",
        ]);
        const positions = all.map((entry) => entry.position);
        const [first, second, third] = positions;
        expect(first !== undefined && second !== undefined && first < second).toBe(true);
        expect(second !== undefined && third !== undefined && second < third).toBe(true);
        const fromSecond = second ?? 0n;
        const tail = Chunk.toReadonlyArray(
          yield* waitFor(
            Stream.runCollect(store.readAll({ fromPosition: fromSecond, batchSize: 1 })),
            (chunk) => Chunk.size(chunk) === 1,
          ),
        );
        expect(tail.map((entry) => entry.position)).toEqual([fromSecond]);
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
        const pending = yield* waitFor(outbox.pending(10), (entries) => entries.length === 3);
        expect(pending.map((entry) => entry.message.id)).toEqual(["m1", "m2", "m3"]);
        expect(pending.map((entry) => entry.status)).toEqual(["pending", "pending", "pending"]);
        expect(pending.map((entry) => entry.attempts)).toEqual([0, 0, 0]);
        expect(pending[0]?.message.topic).toBe("invoices");
        expect(pending[0]?.message.payload).toEqual({ hello: "world" });
        expect(pending[0]?.message.metadata).toEqual({ correlationId: "corr-1" });
        expect((yield* waitFor(outbox.pending(2), (entries) => entries.length === 2)).length).toBe(
          2,
        );

        yield* outbox.markFailed("m2", "broker down", 1);
        const failed = yield* waitFor(outbox.pending(10), (entries) =>
          entries.some((entry) => entry.message.id === "m2" && entry.attempts === 1),
        );
        expect(failed.find((entry) => entry.message.id === "m2")?.status).toBe("pending");
        expect(failed.find((entry) => entry.message.id === "m2")?.lastError).toBe("broker down");

        yield* outbox.markPublished(["m1", "m2"]);
        expect(
          (yield* waitFor(outbox.pending(10), (entries) => entries.length === 1)).map(
            (entry) => entry.message.id,
          ),
        ).toEqual(["m3"]);

        yield* outbox.markDead("m3", "gave up");
        expect(yield* waitFor(outbox.pending(10), (entries) => entries.length === 0)).toEqual([]);
        const dead = yield* waitFor(outbox.deadLetters(), (entries) => entries.length === 1);
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
        const pending = yield* waitFor(outbox.pending(10), (entries) => entries.length === 1);
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
          expect(result.left._tag).toBe("ConcurrencyConflict");
          if (result.left._tag === "ConcurrencyConflict") {
            expect(result.left.actualVersion).toBe(1);
          }
        }
        const stored = Chunk.toReadonlyArray(yield* Stream.runCollect(store.read("Counter-k")));
        expect(stored.length).toBe(1);
        expect(yield* waitFor(outbox.pending(10), (entries) => entries.length === 0)).toEqual([]);
      }),
    ));

  test("appendWithOutbox is atomic: a duplicate outbox id rolls everything back", () =>
    run((options) =>
      Effect.gen(function* () {
        const store = yield* EventStore;
        const outbox = yield* Outbox;
        // A message with this id already exists, so inside the transaction
        // the outbox put (after the event puts) fails its condition and the
        // whole transaction rolls back — surfaced as a defect (DynamoDB has
        // no typed partial-failure channel; the head condition passed).
        yield* outbox.enqueue([message("dup")]);
        const exit = yield* Effect.exit(
          appendWithOutbox("Counter-z", 0, [event(1)], [message("fresh"), message("dup")], options),
        );
        expect(exit._tag).toBe("Failure");
        const stored = Chunk.toReadonlyArray(yield* Stream.runCollect(store.read("Counter-z")));
        expect(stored).toEqual([]);
        const pending = yield* waitFor(outbox.pending(10), (entries) => entries.length === 1);
        expect(pending.map((entry) => entry.message.id)).toEqual(["dup"]);
      }),
    ));

  test("integration: AggregateStore and Projection catchup run on the dynamodb adapters", () =>
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

        // The snapshot landed in the table-backed SnapshotStore.
        const snapshots = yield* SnapshotStore;
        const snapshot = yield* snapshots.load("Counter-i1");
        expect(Option.isSome(snapshot)).toBe(true);
        if (Option.isSome(snapshot)) {
          expect(snapshot.value.version).toBe(2);
          expect(snapshot.value.state).toEqual({ total: 5 });
        }

        // Projection catchup over the GSI feed and checkpoints.
        const applied = yield* Ref.make<ReadonlyArray<string>>([]);
        const appliedSnapshot = (): Effect.Effect<ReadonlyArray<string>> => Ref.get(applied);
        const projection = Projection.make({
          name: "counter-totals",
          registry: counterRegistry,
          when: {
            Incremented: (event) => Ref.update(applied, (all) => [...all, `+${event.amount}`]),
          },
        });
        const caughtUp = yield* waitFor(
          Effect.flatMap(Projection.catchup(projection), () => appliedSnapshot()),
          (events) => events.length >= 2,
        );
        expect(caughtUp).toEqual(["+2", "+3"]);

        const checkpoints = yield* CheckpointStore;
        const position = yield* checkpoints.load("counter-totals");
        expect(position).toBeGreaterThan(0n);
      }),
    ));
};
