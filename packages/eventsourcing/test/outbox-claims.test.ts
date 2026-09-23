import { describe, expect, test } from "bun:test";
import { Effect, Ref } from "effect";
import { InMemoryOutbox, Outbox, OutboxRelay } from "../src/index.js";

const message = (id: string) => ({
  id,
  topic: "invoices",
  payload: { hello: "world" },
  metadata: { correlationId: "corr-1" },
});

describe("Outbox claims", () => {
  test("claim returns due entries with a token and hides them from pending", async () => {
    const program = Effect.gen(function* () {
      const outbox = yield* Outbox;
      yield* outbox.enqueue([
        message("c1"),
        { ...message("c2"), availableAt: Date.now() + 60_000 },
      ]);
      const claim = yield* outbox.claim(10, "30 seconds");
      expect(claim.entries.map((entry) => entry.message.id)).toEqual(["c1"]);
      expect(claim.token.length).toBeGreaterThan(0);
      // A live lease makes the entry invisible to pending and to other claims.
      expect(yield* outbox.pending(10)).toEqual([]);
      expect((yield* outbox.claim(10, "30 seconds")).entries).toEqual([]);
    });
    await Effect.runPromise(program.pipe(Effect.provide(InMemoryOutbox)));
  });

  test("settlement requires the claim token: a stale token changes nothing", async () => {
    const program = Effect.gen(function* () {
      const outbox = yield* Outbox;
      yield* outbox.enqueue([message("f1")]);
      const first = yield* outbox.claim(10, "30 seconds");
      // A foreign token is fenced out: nothing settles.
      expect(yield* outbox.markPublished([message("f1").id], "not-the-token")).toBe(false);
      expect(yield* outbox.markDead("f1", "gave up", first.token)).toBe(true);
      expect(yield* outbox.markDead("f1", "again", first.token)).toBe(false);
      const dead = yield* outbox.deadLetters();
      expect(dead.map((entry) => entry.message.id)).toEqual(["f1"]);
    });
    await Effect.runPromise(program.pipe(Effect.provide(InMemoryOutbox)));
  });

  test("an expired lease makes the entry claimable again (worker crash recovery)", async () => {
    const program = Effect.gen(function* () {
      const outbox = yield* Outbox;
      yield* outbox.enqueue([message("l1")]);
      const crashed = yield* outbox.claim(10, "1 millis");
      expect(crashed.entries.length).toBe(1);
      // The worker "dies" (no settlement); the lease lapses.
      yield* Effect.sleep(10);
      const recovered = yield* outbox.claim(10, "30 seconds");
      expect(recovered.entries.map((entry) => entry.message.id)).toEqual(["l1"]);
      expect(recovered.token).not.toBe(crashed.token);
      // The crashed worker's late settlement is fenced out.
      expect(yield* outbox.markPublished(["l1"], crashed.token)).toBe(false);
      expect(yield* outbox.markPublished(["l1"], recovered.token)).toBe(true);
    });
    await Effect.runPromise(program.pipe(Effect.provide(InMemoryOutbox)));
  });

  test("markFailed under a claim persists the backoff and releases the entry", async () => {
    const program = Effect.gen(function* () {
      const outbox = yield* Outbox;
      yield* outbox.enqueue([message("b1")]);
      const claim = yield* outbox.claim(10, "30 seconds");
      expect(
        yield* outbox.markFailed("b1", "broker down", 1, Date.now() + 60_000, claim.token),
      ).toBe(true);
      // Released and scheduled: invisible to pending and to claims until due.
      expect(yield* outbox.pending(10)).toEqual([]);
      expect((yield* outbox.claim(10, "30 seconds")).entries).toEqual([]);
    });
    await Effect.runPromise(program.pipe(Effect.provide(InMemoryOutbox)));
  });

  test("two concurrent relays deliver each message exactly once", async () => {
    const program = Effect.gen(function* () {
      const outbox = yield* Outbox;
      yield* outbox.enqueue(Array.from({ length: 8 }, (_, index) => message(`dup-${index}`)));
      const deliveries = yield* Ref.make<ReadonlyArray<string>>([]);
      const publish = (entry: { message: { id: string } }) =>
        Ref.update(deliveries, (ids) => [...ids, entry.message.id]);
      const relay = OutboxRelay.drain({ publish, backoffBase: "1 millis", lease: "5 seconds" });
      yield* Effect.all([relay, relay], { discard: true });
      const ids = (yield* Ref.get(deliveries)).slice().sort();
      expect(ids).toEqual(Array.from({ length: 8 }, (_, index) => `dup-${index}`).sort());
    });
    await Effect.runPromise(program.pipe(Effect.provide(InMemoryOutbox)));
  });

  test("the relay abandons an entry whose lease expired and was re-claimed elsewhere", async () => {
    const program = Effect.gen(function* () {
      const outbox = yield* Outbox;
      yield* outbox.enqueue([message("z1")]);
      // Relay claims with a lease so short it expires inside the publish retry.
      const attempts = yield* Ref.make(0);
      const publish = () =>
        Effect.gen(function* () {
          const count = yield* Ref.updateAndGet(attempts, (n) => n + 1);
          if (count === 1) {
            // A second worker takes over the expired lease while we back off.
            yield* Effect.sleep(20);
            const takeover = yield* outbox.claim(1, "30 seconds");
            expect(takeover.entries.length).toBe(1);
            yield* outbox.markPublished(["z1"], takeover.token);
          }
          return yield* Effect.fail(new Error("transient"));
        });
      yield* OutboxRelay.drain({
        publish,
        backoffBase: "5 millis",
        lease: "5 millis",
        maxAttempts: 3,
      });
      // The original claim was fenced out on its first failed settlement:
      // the relay abandoned the entry instead of retrying it.
      expect(yield* Ref.get(attempts)).toBe(1);
      expect(yield* outbox.pending(10)).toEqual([]);
    });
    await Effect.runPromise(program.pipe(Effect.provide(InMemoryOutbox)));
  });
});
