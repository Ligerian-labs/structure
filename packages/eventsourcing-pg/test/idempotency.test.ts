import { describe, expect, test } from "bun:test";
import * as SqlClient from "@effect/sql/SqlClient";
import {
  Authorizer,
  Command,
  CommandBus,
  CommandHandler,
  HandlerRegistry,
  type IdempotencyContext,
  IdempotencyMismatch,
  IdempotencyStore,
} from "@structure-ai/cqrs";
import { Effect, Layer, Ref, Schema } from "effect";
import { type AdapterOptions, layer, purgeExpiredIdempotency, tableNames } from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;

/**
 * Each test gets its own uniquely prefixed table set (created by `layer`,
 * dropped afterwards) so tests never observe each other's records. The
 * scenario receives the resolved options to address its tables directly.
 */
const runTest = <A>(
  scenario: (
    options: AdapterOptions,
  ) => Effect.Effect<A, unknown, IdempotencyStore | SqlClient.SqlClient>,
  options?: Omit<AdapterOptions, "tablePrefix">,
): Promise<A> => {
  const resolved: AdapterOptions = {
    ...options,
    tablePrefix: `i${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}_`,
  };
  const dropTables = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const table of Object.values(tableNames(resolved))) {
      yield* sql`DROP TABLE IF EXISTS ${sql(table)}`;
    }
  }).pipe(Effect.orDie);
  return Effect.runPromise(
    scenario(resolved).pipe(
      Effect.ensuring(dropTables),
      Effect.provide(
        layer({ ...resolved, ...(databaseUrl !== undefined && { url: databaseUrl }) }),
      ),
    ),
  );
};

const context: IdempotencyContext = {
  key: "k",
  tag: "PlaceOrder",
  actor: "ada",
  payloadHash: "h1",
};

const countRows = (options: AdapterOptions) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly n: number | bigint | string }>`
      SELECT count(*) AS n FROM ${sql(tableNames(options).idempotency)}
    `;
    return Number(rows[0]?.n ?? 0);
  });

describe.skipIf(databaseUrl === undefined)("pg IdempotencyStore (needs DATABASE_URL)", () => {
  test("begin/complete/release contract: actor scope, payload identity, in-flight state", () =>
    runTest(() =>
      Effect.gen(function* () {
        const store = yield* IdempotencyStore;
        expect((yield* store.begin(context))._tag).toBe("Claimed");
        expect((yield* store.begin(context))._tag).toBe("InFlight");
        expect((yield* store.begin({ ...context, payloadHash: "h2" }))._tag).toBe("Mismatch");
        expect((yield* store.begin({ ...context, actor: "bob" }))._tag).toBe("Claimed");
        const anonymous: IdempotencyContext = { key: "k", tag: "PlaceOrder", payloadHash: "h1" };
        expect((yield* store.begin(anonymous))._tag).toBe("Claimed");

        yield* store.release(context);
        expect((yield* store.begin(context))._tag).toBe("Claimed");

        yield* store.complete(context, { orderId: "order-1", placedAt: "2026-01-01T00:00:00Z" });
        expect(yield* store.begin(context)).toEqual({
          _tag: "Completed",
          result: { orderId: "order-1", placedAt: "2026-01-01T00:00:00Z" },
        });
        // A completed record survives release and still refuses other payloads.
        yield* store.release(context);
        expect((yield* store.begin(context))._tag).toBe("Completed");
        expect((yield* store.begin({ ...context, payloadHash: "h2" }))._tag).toBe("Mismatch");
        // Other scopes are untouched by ada's completion.
        expect((yield* store.begin({ ...context, actor: "bob" }))._tag).toBe("InFlight");
        expect((yield* store.begin(anonymous))._tag).toBe("InFlight");
      }),
    ));

  test("concurrent begin for one context yields exactly one Claimed", () =>
    runTest(() =>
      Effect.gen(function* () {
        const store = yield* IdempotencyStore;
        const outcomes = yield* Effect.all(
          [store.begin(context), store.begin(context), store.begin(context)],
          { concurrency: "unbounded" },
        );
        const tags = outcomes.map((outcome) => outcome._tag);
        expect(tags.filter((tag) => tag === "Claimed").length).toBe(1);
        expect(tags.filter((tag) => tag === "InFlight").length).toBe(2);
      }),
    ));

  test("expired records are reclaimable by begin and removed by purge", () =>
    runTest(
      (options) =>
        Effect.gen(function* () {
          const store = yield* IdempotencyStore;
          const sql = yield* SqlClient.SqlClient;
          const table = tableNames(options).idempotency;
          // Seed rows already past their TTL (no wall-clock race): a stale
          // claim left by a crashed owner and two expired completions.
          yield* sql`
            INSERT INTO ${sql(table)} (tag, actor, key, payload_hash, status, result, expires_at)
            VALUES ('PlaceOrder', 'ada', 'stale', 'h1', 'claimed', NULL, now() - interval '1 hour'),
                   ('PlaceOrder', 'ada', 'done-1', 'h1', 'completed', '{"ok":true}'::jsonb, now() - interval '1 hour'),
                   ('PlaceOrder', 'ada', 'done-2', 'h1', 'completed', '{"ok":true}'::jsonb, now() - interval '1 hour')
          `;
          // An expired record is absent to `begin`: reclaimed in place, even
          // with another payload, and never replayed.
          expect((yield* store.begin({ ...context, key: "stale", payloadHash: "h2" }))._tag).toBe(
            "Claimed",
          );
          expect((yield* store.begin({ ...context, key: "done-1" }))._tag).toBe("Claimed");
          // Live records on the long TTL behave normally.
          expect((yield* store.begin({ ...context, key: "live" }))._tag).toBe("Claimed");
          yield* store.complete({ ...context, key: "live" }, { ok: true });
          expect((yield* store.begin({ ...context, key: "live" }))._tag).toBe("Completed");
          // Purge removes only rows still expired: reclaimed ones are live again.
          expect(yield* purgeExpiredIdempotency(options)).toBe(1);
          expect(yield* countRows(options)).toBe(3);
          expect(yield* purgeExpiredIdempotency(options)).toBe(0);
          expect((yield* store.begin({ ...context, key: "done-2" }))._tag).toBe("Claimed");
        }),
      { idempotencyTtl: "1 hour" },
    ));

  test("through the CommandBus: per-actor scope, payload mismatch, decoded replay", () =>
    runTest((options) =>
      Effect.gen(function* () {
        const Order = Command.define("PlaceOrder", {
          payload: Schema.Struct({ sku: Schema.String, quantity: Schema.Number }),
          success: Schema.Struct({ orderId: Schema.String, placedAt: Schema.Date }),
        });
        const invocations = yield* Ref.make(0);
        const registration = CommandHandler.make(Order, () =>
          Ref.updateAndGet(invocations, (n) => n + 1).pipe(
            Effect.map((n) => ({ orderId: `order-${n}`, placedAt: new Date(1_700_000_000_000) })),
          ),
        );
        const store = yield* IdempotencyStore;
        const bus = yield* CommandBus.pipe(
          Effect.provide(
            CommandBus.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  HandlerRegistry.layer(registration),
                  Authorizer.allowAll,
                  Layer.succeed(IdempotencyStore, store),
                ),
              ),
            ),
          ),
        );
        const payload = { sku: "sku-1", quantity: 1 };
        const alice = yield* bus.dispatch(Order, payload, { idempotencyKey: "k", actor: "alice" });
        const bob = yield* bus.dispatch(Order, payload, { idempotencyKey: "k", actor: "bob" });
        const replayed = yield* bus.dispatch(Order, payload, {
          idempotencyKey: "k",
          actor: "alice",
        });
        const mismatch = yield* bus
          .dispatch(Order, { sku: "sku-1", quantity: 2 }, { idempotencyKey: "k", actor: "alice" })
          .pipe(Effect.flip);
        expect(yield* Ref.get(invocations)).toBe(2);
        expect(bob.orderId).not.toBe(alice.orderId);
        expect(replayed).toEqual(alice);
        expect(replayed.placedAt).toBeInstanceOf(Date);
        expect(mismatch).toBeInstanceOf(IdempotencyMismatch);
        expect(yield* countRows(options)).toBe(2);
      }),
    ));
});
