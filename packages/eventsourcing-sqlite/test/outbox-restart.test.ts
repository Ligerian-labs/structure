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
 * Two independent layer provisions over one database file simulate a
 * process restart: the schedule persisted by the first adapter must
 * govern the second (durable delayed delivery and durable backoff).
 */
describe("sqlite outbox schedule survives restart", () => {
  test("a scheduled enqueue stays staged until due, across adapters", async () => {
    const file = `${import.meta.dir}/outbox-restart-scheduled.db`;
    cleanup(file);
    const first = Effect.gen(function* () {
      const outbox = yield* Outbox;
      yield* outbox.enqueue([{ ...message("r1"), availableAt: Date.now() + 60_000 }]);
    }).pipe(Effect.provide(layer({ filename: file })));
    await Effect.runPromise(Effect.orDie(first));

    // "Restart": a brand-new client + adapter over the same file.
    const second = Effect.gen(function* () {
      const outbox = yield* Outbox;
      // Not due yet — invisible to the relay.
      expect(yield* outbox.pending(10)).toEqual([]);
      // Simulate time passing: the schedule elapses.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE outbox SET available_at = ${Date.now() - 1}`;
      const pending = yield* outbox.pending(10);
      expect(pending.map((entry) => entry.message.id)).toEqual(["r1"]);
      expect(pending[0]?.availableAt).not.toBeUndefined();
      expect(pending[0]?.availableAt ?? 0).toBeLessThanOrEqual(Date.now());
    }).pipe(Effect.provide(layer({ filename: file })));
    await Effect.runPromise(Effect.orDie(second));
    cleanup(file);
  });

  test("a durable backoff persisted by markFailed survives restart", async () => {
    const file = `${import.meta.dir}/outbox-restart-backoff.db`;
    cleanup(file);
    const first = Effect.gen(function* () {
      const outbox = yield* Outbox;
      yield* outbox.enqueue([message("b1")]);
      // The relay fails once and persists the backoff schedule.
      yield* outbox.markFailed("b1", "broker down", 1, Date.now() + 60_000);
    }).pipe(Effect.provide(layer({ filename: file })));
    await Effect.runPromise(Effect.orDie(first));

    const second = Effect.gen(function* () {
      const outbox = yield* Outbox;
      // A restarted relay must not offer the entry before the schedule.
      expect(yield* outbox.pending(10)).toEqual([]);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE outbox SET available_at = ${Date.now() - 1}`;
      const pending = yield* outbox.pending(10);
      expect(pending.map((entry) => entry.message.id)).toEqual(["b1"]);
      expect(pending[0]?.attempts).toBe(1);
      expect(pending[0]?.lastError).toBe("broker down");
    }).pipe(Effect.provide(layer({ filename: file })));
    await Effect.runPromise(Effect.orDie(second));
    cleanup(file);
  });
});
