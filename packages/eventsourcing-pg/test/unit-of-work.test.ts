/**
 * Application unit of work (#77): every write issued inside
 * `withUnitOfWork` — aggregate appends, outbox enqueue, inbox dedupe,
 * idempotency claims, snapshots, and application-owned SQL on the same
 * `SqlClient` — commits as ONE PostgreSQL transaction, and a failure
 * anywhere rolls the whole unit back.
 *
 * Runs against `DATABASE_URL` only (see pg.test.ts).
 */
import { describe, expect, test } from "bun:test";
import * as SqlClient from "@effect/sql/SqlClient";
import { type IdempotencyContext, IdempotencyStore } from "@structure-ai/cqrs";
import { EventStore, Inbox, Outbox, SnapshotStore } from "@structure-ai/eventsourcing";
import { Chunk, Deferred, Effect, Either, Exit, Fiber, Option, Predicate, Stream } from "effect";
import { type AdapterOptions, layer, tableNames, withUnitOfWork } from "../src/index.js";
import { testMetadata } from "./fixtures.js";
import type { TestServices } from "./scenarios.js";

const databaseUrl = process.env.DATABASE_URL;

/**
 * A scenario with its own prefixed table set plus one application-owned
 * table (`runTest` passes its name in), dropped afterwards.
 * `maxConnections` above one so a reader outside an open unit gets a second
 * pooled connection instead of queueing behind the transaction.
 */
/** Services a unit-of-work scenario may use: the ports, idempotency, and the raw sql client. */
type UowServices = TestServices | IdempotencyStore;

const runTest = (
  scenario: (
    options: AdapterOptions,
    appTable: string,
  ) => Effect.Effect<void, unknown, UowServices>,
): Promise<void> => {
  const tablePrefix = `t${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}_`;
  const tables = tableNames({ tablePrefix });
  const appTable = `${tablePrefix}registrations`;
  const dropTables = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DROP TABLE IF EXISTS ${sql(appTable)}`;
    for (const table of Object.values(tables)) {
      yield* sql`DROP TABLE IF EXISTS ${sql(table)}`;
    }
  }).pipe(Effect.orDie);
  return Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE ${sql(appTable)} (id text PRIMARY KEY, email text)`;
      yield* scenario({ tablePrefix }, appTable);
    }).pipe(
      Effect.ensuring(dropTables),
      Effect.provide(
        layer(
          databaseUrl === undefined
            ? { tablePrefix, maxConnections: 4 }
            : { tablePrefix, url: databaseUrl, maxConnections: 4 },
        ),
      ),
    ),
  );
};

const event = (version: number) => ({
  type: "Incremented",
  schemaVersion: 1,
  payload: { _tag: "Incremented", amount: version },
  metadata: testMetadata(version),
});

const message = (id: string) => ({
  id,
  topic: "registrations",
  payload: { hello: "world" },
  metadata: { correlationId: "corr-1" },
});

const idempotencyContext: IdempotencyContext = {
  key: "register-user-1",
  tag: "RegisterUser",
  actor: "anon-1",
  payloadHash: "hash-1",
};

/** Versions of one stream, cheap to assert on. */
const versions = (events: ReadonlyArray<{ readonly version: number }>): ReadonlyArray<number> =>
  events.map((stored) => stored.version);

describe.skipIf(databaseUrl === undefined)("application unit of work (needs DATABASE_URL)", () => {
  test("two aggregate appends plus an outbox enqueue commit atomically", () =>
    runTest(() =>
      Effect.gen(function* () {
        const store = yield* EventStore;
        const outbox = yield* Outbox;
        yield* withUnitOfWork(
          Effect.gen(function* () {
            yield* store.append("Counter-a", 0, [event(1)]);
            yield* store.append("Counter-b", 0, [event(1), event(2)]);
            yield* outbox.enqueue([message("m-1")]);
          }),
        );
        const streamA = Chunk.toReadonlyArray(yield* Stream.runCollect(store.read("Counter-a")));
        const streamB = Chunk.toReadonlyArray(yield* Stream.runCollect(store.read("Counter-b")));
        expect(versions(streamA)).toEqual([1]);
        expect(versions(streamB)).toEqual([1, 2]);
        const pending = yield* outbox.pending(10);
        expect(pending.map((entry) => entry.message.id)).toEqual(["m-1"]);
      }),
    ));

  test("a failure after either append rolls back every write", () =>
    runTest(() =>
      Effect.gen(function* () {
        const store = yield* EventStore;
        const outbox = yield* Outbox;
        const result = yield* Effect.either(
          withUnitOfWork(
            Effect.gen(function* () {
              yield* store.append("Counter-c", 0, [event(1)]);
              yield* store.append("Counter-d", 0, [event(1)]);
              return yield* Effect.fail(new Error("registration step failed"));
            }),
          ),
        );
        expect(Either.isLeft(result)).toBe(true);
        const streamC = Chunk.toReadonlyArray(yield* Stream.runCollect(store.read("Counter-c")));
        const streamD = Chunk.toReadonlyArray(yield* Stream.runCollect(store.read("Counter-d")));
        expect(streamC).toEqual([]);
        expect(streamD).toEqual([]);
        expect(yield* outbox.pending(10)).toEqual([]);
      }),
    ));

  test("application SQL written through the same unit rolls back with event and outbox writes", () =>
    runTest((_options, appTable) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = yield* EventStore;
        const outbox = yield* Outbox;
        yield* withUnitOfWork(
          Effect.gen(function* () {
            yield* store.append("Counter-e", 0, [event(1)]);
            yield* outbox.enqueue([message("m-2")]);
            yield* sql`INSERT INTO ${sql(appTable)} (id, email) VALUES ('keep', 'keep@example.com')`;
          }),
        );
        const rolledBack = yield* Effect.exit(
          withUnitOfWork(
            Effect.gen(function* () {
              yield* sql`INSERT INTO ${sql(appTable)} (id, email) VALUES ('drop', 'drop@example.com')`;
              yield* store.append("Counter-f", 0, [event(1)]);
              yield* outbox.enqueue([message("m-3")]);
              return yield* Effect.die(new Error("boom after every write"));
            }),
          ),
        );
        expect(Exit.isFailure(rolledBack)).toBe(true);
        const kept = yield* sql<{
          readonly id: string;
        }>`SELECT id FROM ${sql(appTable)} ORDER BY id`;
        expect(kept.map((row) => row.id)).toEqual(["keep"]);
        const streamF = Chunk.toReadonlyArray(yield* Stream.runCollect(store.read("Counter-f")));
        expect(streamF).toEqual([]);
        // m-2 committed with its unit; m-3 was staged only inside the
        // rolled-back one and must not exist.
        expect((yield* outbox.pending(10)).map((entry) => entry.message.id)).toEqual(["m-2"]);
      }),
    ));

  test("concurrency conflicts stay typed and the unit leaves nothing behind, so a retry is safe", () =>
    runTest(() =>
      Effect.gen(function* () {
        const store = yield* EventStore;
        const outbox = yield* Outbox;
        const conflicting = yield* Effect.either(
          withUnitOfWork(
            Effect.gen(function* () {
              yield* store.append("Counter-g", 0, [event(1)]);
              // Stale expected version: the append above (same unit, same
              // transaction) already moved the stream to version 1.
              yield* store.append("Counter-g", 0, [event(2)]);
            }),
          ),
        );
        expect(Either.isLeft(conflicting)).toBe(true);
        if (
          Either.isLeft(conflicting) &&
          Predicate.isTagged(conflicting.left, "ConcurrencyConflict")
        ) {
          expect(conflicting.left._tag).toBe("ConcurrencyConflict");
          expect(conflicting.left.entity).toBe("Counter");
          expect(conflicting.left.id).toBe("g");
          expect(conflicting.left.expectedVersion).toBe(0);
          expect(conflicting.left.actualVersion).toBe(1);
        }
        const afterConflict = Chunk.toReadonlyArray(
          yield* Stream.runCollect(store.read("Counter-g")),
        );
        expect(afterConflict).toEqual([]);
        // Retry-safe: the rolled-back unit wrote nothing, so the same
        // command with the correct expected version succeeds.
        yield* withUnitOfWork(
          Effect.gen(function* () {
            yield* store.append("Counter-g", 0, [event(1), event(2)]);
            yield* outbox.enqueue([message("m-4")]);
          }),
        );
        const retried = Chunk.toReadonlyArray(yield* Stream.runCollect(store.read("Counter-g")));
        expect(versions(retried)).toEqual([1, 2]);
        expect((yield* outbox.pending(10)).map((entry) => entry.message.id)).toEqual(["m-4"]);
      }),
    ));

  test("a nested unit rolls back to its savepoint only; the outer unit keeps committing", () =>
    runTest(() =>
      Effect.gen(function* () {
        const store = yield* EventStore;
        const inner = withUnitOfWork(
          Effect.gen(function* () {
            yield* store.append("Counter-h", 0, [event(1)]);
            return yield* Effect.fail(new Error("inner unit failed"));
          }),
        );
        yield* withUnitOfWork(
          Effect.gen(function* () {
            yield* store.append("Counter-i", 0, [event(1)]);
            const caught = yield* Effect.either(inner);
            expect(Either.isLeft(caught)).toBe(true);
            yield* store.append("Counter-j", 0, [event(1)]);
          }),
        );
        const streamH = Chunk.toReadonlyArray(yield* Stream.runCollect(store.read("Counter-h")));
        const streamI = Chunk.toReadonlyArray(yield* Stream.runCollect(store.read("Counter-i")));
        const streamJ = Chunk.toReadonlyArray(yield* Stream.runCollect(store.read("Counter-j")));
        expect(streamH).toEqual([]);
        expect(versions(streamI)).toEqual([1]);
        expect(versions(streamJ)).toEqual([1]);
      }),
    ));

  test("a nested failure the outer unit does not catch rolls back everything", () =>
    runTest(() =>
      Effect.gen(function* () {
        const store = yield* EventStore;
        const result = yield* Effect.either(
          withUnitOfWork(
            Effect.gen(function* () {
              yield* store.append("Counter-k", 0, [event(1)]);
              yield* withUnitOfWork(
                Effect.gen(function* () {
                  yield* store.append("Counter-l", 0, [event(1)]);
                  return yield* Effect.fail(new Error("inner unit failed"));
                }),
              );
            }),
          ),
        );
        expect(Either.isLeft(result)).toBe(true);
        const streamK = Chunk.toReadonlyArray(yield* Stream.runCollect(store.read("Counter-k")));
        const streamL = Chunk.toReadonlyArray(yield* Stream.runCollect(store.read("Counter-l")));
        expect(streamK).toEqual([]);
        expect(streamL).toEqual([]);
      }),
    ));

  test("staged outbox facts and events are invisible outside the open unit, visible only after commit", () =>
    runTest(() =>
      Effect.gen(function* () {
        const store = yield* EventStore;
        const outbox = yield* Outbox;
        const opened = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const unit = withUnitOfWork(
          Effect.gen(function* () {
            yield* store.append("Counter-m", 0, [event(1)]);
            yield* outbox.enqueue([message("m-5")]);
            yield* Deferred.succeed(opened, void 0);
            yield* Deferred.await(release);
          }),
        );
        const fiber = yield* Effect.fork(unit);
        yield* Deferred.await(opened);
        // A reader on another pooled connection cannot see the open
        // transaction: nothing is published until the unit commits.
        expect(yield* outbox.pending(10)).toEqual([]);
        const duringStream = Chunk.toReadonlyArray(
          yield* Stream.runCollect(store.read("Counter-m")),
        );
        expect(duringStream).toEqual([]);
        yield* Deferred.succeed(release, void 0);
        yield* Fiber.await(fiber);
        const after = yield* outbox.pending(10);
        expect(after.map((entry) => entry.message.id)).toEqual(["m-5"]);
        const streamM = Chunk.toReadonlyArray(yield* Stream.runCollect(store.read("Counter-m")));
        expect(versions(streamM)).toEqual([1]);
      }),
    ));

  test("inbox dedupe, idempotency claims, and snapshots participate in the unit", () =>
    runTest(() =>
      Effect.gen(function* () {
        const inbox = yield* Inbox;
        const idempotency = yield* IdempotencyStore;
        const snapshots = yield* SnapshotStore;
        const result = yield* Effect.exit(
          withUnitOfWork(
            Effect.gen(function* () {
              yield* inbox.markProcessed("registrar", "msg-1");
              const claimed = yield* idempotency.begin(idempotencyContext);
              expect(claimed._tag).toBe("Claimed");
              yield* idempotency.complete(idempotencyContext, { ok: true });
              yield* snapshots.save("Counter-n", { state: { total: 1 }, version: 1 });
              return yield* Effect.fail(new Error("rollback the whole unit"));
            }),
          ),
        );
        expect(Exit.isFailure(result)).toBe(true);
        // Every write above was rolled back with the unit.
        expect(yield* inbox.seen("registrar", "msg-1")).toBe(false);
        const reclaimed = yield* idempotency.begin(idempotencyContext);
        expect(reclaimed._tag).toBe("Claimed");
        expect(Option.isNone(yield* snapshots.load("Counter-n"))).toBe(true);
        // And the same writes commit when the unit succeeds.
        yield* withUnitOfWork(
          Effect.gen(function* () {
            yield* inbox.markProcessed("registrar", "msg-2");
            yield* idempotency.begin(idempotencyContext);
            yield* idempotency.complete(idempotencyContext, { ok: true });
          }),
        );
        expect(yield* inbox.seen("registrar", "msg-2")).toBe(true);
        const completed = yield* idempotency.begin(idempotencyContext);
        expect(completed._tag).toBe("Completed");
      }),
    ));
});
