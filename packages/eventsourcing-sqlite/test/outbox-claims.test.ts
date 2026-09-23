import { describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import * as SqlClient from "@effect/sql/SqlClient";
import type { OutboxMessage } from "@structure-ai/eventsourcing";
import { Outbox } from "@structure-ai/eventsourcing";
import { Effect } from "effect";
import { layer } from "../src/index.js";

const message = (id: string): OutboxMessage => ({
  id,
  topic: "invoices",
  payload: { hello: "world" },
  metadata: { correlationId: "corr-1" },
});

const cleanup = (file: string): void => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${file}${suffix}`);
    } catch {
      // already gone
    }
  }
};

/**
 * Claim/lease semantics on the durable SQLite adapter: the single UPDATE
 * that claims must hide its rows from every other relay until the lease
 * lapses, and settlements must be fenced by the claim token.
 */
describe("sqlite outbox claims", () => {
  test("claim hides entries from other relays until the lease lapses", async () => {
    const file = `${import.meta.dir}/outbox-claims-lease.db`;
    cleanup(file);
    const provide = layer({ filename: file });
    await Effect.runPromise(
      Effect.gen(function* () {
        const outbox = yield* Outbox;
        yield* outbox.enqueue([message("k1"), message("k2")]);
        const first = yield* outbox.claim(10, "30 seconds");
        expect(first.entries.map((entry) => entry.message.id)).toEqual(["k1", "k2"]);
        // A second relay sees nothing while the lease is live.
        expect(yield* outbox.pending(10)).toEqual([]);
        expect((yield* outbox.claim(10, "30 seconds")).entries).toEqual([]);
        // Publishing under the claim token settles and releases.
        expect(yield* outbox.markPublished(["k1"], first.token)).toBe(true);
        // A stale token (already-settled entry) changes nothing.
        expect(yield* outbox.markPublished(["k1"], first.token)).toBe(false);
      }).pipe(Effect.provide(provide), Effect.orDie),
    );
    cleanup(file);
  });

  test("two concurrent relays partition the entries between them", async () => {
    const file = `${import.meta.dir}/outbox-claims-race.db`;
    cleanup(file);
    const provide = layer({ filename: file });
    await Effect.runPromise(
      Effect.gen(function* () {
        const outbox = yield* Outbox;
        yield* outbox.enqueue(Array.from({ length: 6 }, (_, index) => message(`r-${index}`)));
        const first = yield* outbox.claim(3, "30 seconds");
        const second = yield* outbox.claim(3, "30 seconds");
        const firstIds = first.entries.map((entry) => entry.message.id);
        const secondIds = second.entries.map((entry) => entry.message.id);
        // No overlap: each entry is delivered by exactly one relay.
        expect(firstIds.length).toBe(3);
        expect(secondIds.length).toBe(3);
        expect(new Set([...firstIds, ...secondIds]).size).toBe(6);
        // Everything is claimed: nothing left for a third relay.
        expect((yield* outbox.claim(3, "30 seconds")).entries).toEqual([]);
      }).pipe(Effect.provide(provide), Effect.orDie),
    );
    cleanup(file);
  });

  test("an expired lease is recoverable and fences the crashed relay's settlement", async () => {
    const file = `${import.meta.dir}/outbox-claims-expiry.db`;
    cleanup(file);
    const provide = layer({ filename: file });
    await Effect.runPromise(
      Effect.gen(function* () {
        const outbox = yield* Outbox;
        yield* outbox.enqueue([message("e1")]);
        const crashed = yield* outbox.claim(1, "1 millis");
        expect(crashed.entries.length).toBe(1);
        // The worker "dies" (never settles); the lease lapses.
        yield* Effect.sleep(10);
        const recovered = yield* outbox.claim(1, "30 seconds");
        expect(recovered.entries.map((entry) => entry.message.id)).toEqual(["e1"]);
        expect(recovered.token).not.toBe(crashed.token);
        // The crashed worker's late settlement is fenced out...
        expect(yield* outbox.markPublished(["e1"], crashed.token)).toBe(false);
        // ...while the recovering relay settles fine.
        expect(yield* outbox.markPublished(["e1"], recovered.token)).toBe(true);
        expect(yield* outbox.pending(10)).toEqual([]);
      }).pipe(Effect.provide(provide), Effect.orDie),
    );
    cleanup(file);
  });

  test("a claim and its lease survive a process restart", async () => {
    const file = `${import.meta.dir}/outbox-claims-restart.db`;
    cleanup(file);
    const first = Effect.gen(function* () {
      const outbox = yield* Outbox;
      yield* outbox.enqueue([message("s1")]);
      yield* outbox.claim(1, "30 seconds");
    }).pipe(Effect.provide(layer({ filename: file })), Effect.orDie);
    await Effect.runPromise(first);

    // "Restart": a brand-new client + adapter over the same file. The claim
    // is durable state: the entry stays invisible past the restart.
    const second = Effect.gen(function* () {
      const outbox = yield* Outbox;
      expect(yield* outbox.pending(10)).toEqual([]);
      expect((yield* outbox.claim(10, "30 seconds")).entries).toEqual([]);
      // Simulate the lease lapsing: the restarted relay recovers the entry.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE outbox SET lease_until = ${Date.now() - 1}`;
      const recovered = yield* outbox.claim(10, "30 seconds");
      expect(recovered.entries.map((entry) => entry.message.id)).toEqual(["s1"]);
    }).pipe(Effect.provide(layer({ filename: file })), Effect.orDie);
    await Effect.runPromise(second);
    cleanup(file);
  });
});
