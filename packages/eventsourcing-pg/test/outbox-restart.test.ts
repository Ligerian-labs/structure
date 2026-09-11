import { describe, expect, test } from "bun:test";
import * as SqlClient from "@effect/sql/SqlClient";
import type { OutboxMessage } from "@structure-ai/eventsourcing";
import { Outbox } from "@structure-ai/eventsourcing";
import { Effect } from "effect";
import { layer, tableNames } from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;

const message = (id: string): OutboxMessage => ({
  id,
  topic: "invoices",
  payload: { hello: "world" },
  metadata: { correlationId: "corr-1" },
});

/**
 * Two independent layer provisions over one set of prefixed tables
 * simulate a process restart: the schedule persisted by the first adapter
 * must govern the second (durable delayed delivery and durable backoff).
 */
describe.skipIf(databaseUrl === undefined)(
  "pg outbox schedule survives restart (needs DATABASE_URL)",
  () => {
    test("a scheduled enqueue stays staged until due, across adapters", async () => {
      const tablePrefix = `t${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}_`;
      const tables = tableNames({ tablePrefix });
      const provide = layer(
        databaseUrl === undefined ? { tablePrefix } : { tablePrefix, url: databaseUrl },
      );
      const dropTables = Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (const table of Object.values(tables)) {
          yield* sql`DROP TABLE IF EXISTS ${sql(table)}`;
        }
      }).pipe(Effect.orDie);
      await Effect.runPromise(
        Effect.gen(function* () {
          const outbox = yield* Outbox;
          yield* outbox.enqueue([{ ...message("r1"), availableAt: Date.now() + 60_000 }]);
        }).pipe(Effect.provide(provide), Effect.orDie),
      );
      // "Restart": a brand-new client + adapter over the same tables.
      const second = Effect.gen(function* () {
        const outbox = yield* Outbox;
        expect(yield* outbox.pending(10)).toEqual([]);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE ${sql(tables.outbox)} SET available_at = ${Date.now() - 1}`;
        const pending = yield* outbox.pending(10);
        expect(pending.map((entry) => entry.message.id)).toEqual(["r1"]);
        expect(pending[0]?.availableAt ?? 0).toBeLessThanOrEqual(Date.now());
      }).pipe(Effect.ensuring(dropTables), Effect.provide(provide), Effect.orDie);
      await Effect.runPromise(second);
    });

    test("a durable backoff persisted by markFailed survives restart", async () => {
      const tablePrefix = `t${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}_`;
      const tables = tableNames({ tablePrefix });
      const provide = layer(
        databaseUrl === undefined ? { tablePrefix } : { tablePrefix, url: databaseUrl },
      );
      const dropTables = Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (const table of Object.values(tables)) {
          yield* sql`DROP TABLE IF EXISTS ${sql(table)}`;
        }
      }).pipe(Effect.orDie);
      await Effect.runPromise(
        Effect.gen(function* () {
          const outbox = yield* Outbox;
          yield* outbox.enqueue([message("b1")]);
          yield* outbox.markFailed("b1", "broker down", 1, Date.now() + 60_000);
        }).pipe(Effect.provide(provide), Effect.orDie),
      );
      const second = Effect.gen(function* () {
        const outbox = yield* Outbox;
        expect(yield* outbox.pending(10)).toEqual([]);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE ${sql(tables.outbox)} SET available_at = ${Date.now() - 1}`;
        const pending = yield* outbox.pending(10);
        expect(pending.map((entry) => entry.message.id)).toEqual(["b1"]);
        expect(pending[0]?.attempts).toBe(1);
        expect(pending[0]?.lastError).toBe("broker down");
      }).pipe(Effect.ensuring(dropTables), Effect.provide(provide), Effect.orDie);
      await Effect.runPromise(second);
    });
  },
);
