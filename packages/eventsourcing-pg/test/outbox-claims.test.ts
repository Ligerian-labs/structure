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
 * Claim/lease semantics on the PostgreSQL adapter: `FOR UPDATE SKIP LOCKED`
 * gives concurrent relays disjoint batches, and settlements are fenced by
 * the claim token (stale leases from crashed workers never write).
 */
describe.skipIf(databaseUrl === undefined)("pg outbox claims (needs DATABASE_URL)", () => {
  test("claim hides entries from other relays until the lease lapses", async () => {
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
      }).pipe(Effect.ensuring(dropTables), Effect.provide(provide), Effect.orDie),
    );
  });

  test("two concurrent relays partition the entries between them", async () => {
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
        yield* outbox.enqueue(Array.from({ length: 6 }, (_, index) => message(`r-${index}`)));
        // Two claims racing inside one transaction each: their batches
        // must be disjoint (SKIP LOCKED), and together exhaustive.
        const first = yield* outbox.claim(3, "30 seconds");
        const second = yield* outbox.claim(3, "30 seconds");
        const firstIds = first.entries.map((entry) => entry.message.id);
        const secondIds = second.entries.map((entry) => entry.message.id);
        expect(firstIds.length).toBe(3);
        expect(secondIds.length).toBe(3);
        expect(new Set([...firstIds, ...secondIds]).size).toBe(6);
        expect((yield* outbox.claim(3, "30 seconds")).entries).toEqual([]);
      }).pipe(Effect.ensuring(dropTables), Effect.provide(provide), Effect.orDie),
    );
  });

  test("an expired lease is recoverable and fences the crashed relay's settlement", async () => {
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
      }).pipe(Effect.ensuring(dropTables), Effect.provide(provide), Effect.orDie),
    );
  });

  test("a claim survives a restart and the entry stays leased", async () => {
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
        yield* outbox.enqueue([message("s1")]);
        yield* outbox.claim(1, "30 seconds");
      }).pipe(Effect.provide(provide), Effect.orDie),
    );
    // "Restart": a brand-new client + adapter over the same tables.
    await Effect.runPromise(
      Effect.gen(function* () {
        const outbox = yield* Outbox;
        expect(yield* outbox.pending(10)).toEqual([]);
        expect((yield* outbox.claim(10, "30 seconds")).entries).toEqual([]);
        // Simulate the lease lapsing: the restarted relay recovers it.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE ${sql(tables.outbox)} SET lease_until = ${Date.now() - 1}`;
        const recovered = yield* outbox.claim(10, "30 seconds");
        expect(recovered.entries.map((entry) => entry.message.id)).toEqual(["s1"]);
      }).pipe(Effect.ensuring(dropTables), Effect.provide(provide), Effect.orDie),
    );
  });
});
