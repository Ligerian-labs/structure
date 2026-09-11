import { describe, expect, test } from "bun:test";
import { Effect, Option, Ref } from "effect";
import { Inbox, InMemoryInbox, InMemoryOutbox, Outbox, OutboxRelay } from "../src/index.js";

const message = (id: string) => ({
  id,
  topic: "invoices",
  payload: { hello: "world" },
  metadata: { correlationId: "corr-1" },
});

describe("OutboxRelay", () => {
  test("transient publisher failure: retried with backoff, then published", async () => {
    const program = Effect.gen(function* () {
      const outbox = yield* Outbox;
      yield* outbox.enqueue([message("m1")]);
      const attempts = yield* Ref.make(0);
      const publish = () =>
        Effect.gen(function* () {
          const count = yield* Ref.updateAndGet(attempts, (n) => n + 1);
          if (count <= 2) {
            return yield* Effect.fail(new Error(`transient failure ${count}`));
          }
        });
      yield* OutboxRelay.drain({ publish, backoffBase: "1 millis" });
      expect(yield* Ref.get(attempts)).toBe(3);
      expect(yield* outbox.pending(10)).toEqual([]);
      expect(yield* outbox.deadLetters()).toEqual([]);
    });
    await Effect.runPromise(program.pipe(Effect.provide(InMemoryOutbox)));
  });

  test("permanent publisher failure: dead-lettered after maxAttempts with error context", async () => {
    const program = Effect.gen(function* () {
      const outbox = yield* Outbox;
      yield* outbox.enqueue([message("m2")]);
      const attempts = yield* Ref.make(0);
      const publish = () =>
        Ref.update(attempts, (n) => n + 1).pipe(
          Effect.andThen(Effect.fail(new Error("kaboom: broker unreachable"))),
        );
      yield* OutboxRelay.drain({ publish, maxAttempts: 3, backoffBase: "1 millis" });
      expect(yield* Ref.get(attempts)).toBe(3);
      expect(yield* outbox.pending(10)).toEqual([]);
      const dead = yield* outbox.deadLetters();
      expect(dead.length).toBe(1);
      const entry = dead[0];
      if (entry === undefined) {
        throw new Error("expected a dead letter");
      }
      expect(entry.status).toBe("dead");
      expect(entry.attempts).toBe(3);
      expect(entry.lastError).toContain("kaboom");
      expect(entry.message.id).toBe("m2");
    });
    await Effect.runPromise(program.pipe(Effect.provide(InMemoryOutbox)));
  });

  test("enqueue is idempotent per message id", async () => {
    const program = Effect.gen(function* () {
      const outbox = yield* Outbox;
      yield* outbox.enqueue([message("m3")]);
      yield* outbox.enqueue([message("m3")]);
      expect((yield* outbox.pending(10)).length).toBe(1);
    });
    await Effect.runPromise(program.pipe(Effect.provide(InMemoryOutbox)));
  });

  test("a failed attempt persists a due time the next relay pass respects", async () => {
    const program = Effect.gen(function* () {
      const outbox = yield* Outbox;
      yield* outbox.enqueue([message("m4")]);
      yield* outbox.markFailed("m4", "broker down", 1, Date.now() + 60_000);
      const published = yield* Ref.make(0);
      const publish = () => Ref.update(published, (n) => n + 1);
      // The retry schedule is durable: a fresh relay pass sees nothing due.
      yield* OutboxRelay.drain({ publish });
      expect(yield* Ref.get(published)).toBe(0);
      // Once the schedule elapses, the entry is delivered again.
      yield* outbox.markFailed("m4", "broker down", 1, Date.now() - 1);
      yield* OutboxRelay.drain({ publish });
      expect(yield* Ref.get(published)).toBe(1);
      expect(yield* outbox.pending(10)).toEqual([]);
    });
    await Effect.runPromise(program.pipe(Effect.provide(InMemoryOutbox)));
  });

  test("a scheduled enqueue is not offered to the publisher until due", async () => {
    const program = Effect.gen(function* () {
      const outbox = yield* Outbox;
      yield* outbox.enqueue([{ ...message("m5"), availableAt: Date.now() + 60_000 }]);
      const published = yield* Ref.make(0);
      const publish = () => Ref.update(published, (n) => n + 1);
      yield* OutboxRelay.drain({ publish });
      expect(yield* Ref.get(published)).toBe(0);
      yield* outbox.enqueue([{ ...message("m6"), availableAt: Date.now() - 1 }]);
      yield* OutboxRelay.drain({ publish });
      expect(yield* Ref.get(published)).toBe(1);
      // m5 is still staged, just not due: pending never offers it.
      expect(yield* outbox.pending(10)).toEqual([]);
    });
    await Effect.runPromise(program.pipe(Effect.provide(InMemoryOutbox)));
  });

  test("replay requeues dead letters with a clean slate", async () => {
    const program = Effect.gen(function* () {
      const outbox = yield* Outbox;
      yield* outbox.enqueue([
        message("m7"),
        { ...message("m8"), availableAt: Date.now() + 60_000 },
      ]);
      yield* outbox.markFailed("m8", "broker down", 2, Date.now() + 60_000);
      yield* outbox.markDead("m7", "gave up");
      yield* outbox.markDead("m8", "gave up again");
      // Replaying unknown ids and non-dead entries changes nothing.
      yield* outbox.replay(["nope"]);
      expect((yield* outbox.deadLetters()).length).toBe(2);
      yield* outbox.replay(["m7", "m8"]);
      expect(yield* outbox.deadLetters()).toEqual([]);
      const pending = yield* outbox.pending(10);
      expect(pending.map((entry) => entry.message.id)).toEqual(["m7", "m8"]);
      for (const entry of pending) {
        expect(entry.attempts).toBe(0);
        expect(entry.lastError).toBeUndefined();
        expect(entry.availableAt).toBeUndefined();
      }
    });
    await Effect.runPromise(program.pipe(Effect.provide(InMemoryOutbox)));
  });
});

describe("Inbox", () => {
  test("dedupe runs the effect once for a duplicate messageId", async () => {
    const program = Effect.gen(function* () {
      const runs = yield* Ref.make(0);
      const handler = Ref.update(runs, (n) => n + 1).pipe(Effect.as("handled"));
      const first = yield* Inbox.dedupe("billing", "msg-1")(handler);
      const second = yield* Inbox.dedupe("billing", "msg-1")(handler);
      const otherConsumer = yield* Inbox.dedupe("shipping", "msg-1")(handler);
      expect(yield* Ref.get(runs)).toBe(2);
      expect(first).toEqual(Option.some("handled"));
      expect(Option.isNone(second)).toBe(true);
      expect(Option.isSome(otherConsumer)).toBe(true);
    });
    await Effect.runPromise(program.pipe(Effect.provide(InMemoryInbox)));
  });

  test("dedupe does not mark a failed effect as processed", async () => {
    const program = Effect.gen(function* () {
      const runs = yield* Ref.make(0);
      const failing = Ref.update(runs, (n) => n + 1).pipe(
        Effect.andThen(Effect.fail(new Error("boom"))),
      );
      const first = yield* Effect.either(Inbox.dedupe("billing", "msg-2")(failing));
      expect(first._tag).toBe("Left");
      const retry = yield* Inbox.dedupe("billing", "msg-2")(Effect.succeed("ok"));
      expect(retry).toEqual(Option.some("ok"));
      expect(yield* Ref.get(runs)).toBe(1);
    });
    await Effect.runPromise(program.pipe(Effect.provide(InMemoryInbox)));
  });
});
