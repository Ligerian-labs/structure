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
