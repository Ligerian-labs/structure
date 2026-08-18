import { describe, expect, test } from "bun:test";
import * as SqlClient from "@effect/sql/SqlClient";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { DateTime, Effect, Option, Schema } from "effect";
import { createTableSql, ViewModel, ViewStore } from "../src/index.js";

const sqlite = () => SqliteClient.layer({ filename: ":memory:" });

const Payment = ViewModel.define({
  name: "PaymentView",
  fields: {
    id: Schema.String,
    amount: Schema.Number,
    attempts: Schema.Int,
    settled: Schema.Boolean,
    note: Schema.optional(Schema.String),
    occurredAt: Schema.DateTimeUtc,
    details: Schema.Struct({ method: Schema.String, last4: Schema.String }),
    tags: Schema.Array(Schema.String),
  },
});
type Payment = ViewModel.Of<typeof Payment>;

const paymentStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.unsafe(createTableSql(Payment));
  return yield* ViewStore.make(Payment);
});

const at = DateTime.unsafeMake("2024-05-06T07:08:09.000Z");

const p1: Payment = {
  id: "p1",
  amount: 12.5,
  attempts: 3,
  settled: false,
  occurredAt: at,
  details: { method: "card", last4: "4242" },
  tags: ["retail", "eu"],
};

const runWith = <A>(program: Effect.Effect<A, unknown, SqlClient.SqlClient>) =>
  Effect.runPromise(
    program.pipe(Effect.provide(sqlite()), Effect.scoped) as Effect.Effect<A, unknown>,
  );

describe("ViewStore roundtrip", () => {
  test("upsert → get roundtrips every storage class; upsert again updates", async () => {
    await runWith(
      Effect.gen(function* () {
        const store = yield* paymentStore;
        yield* store.upsert(p1);
        const got = yield* store.get("p1");
        expect(got.id).toBe("p1");
        expect(got.amount).toBe(12.5);
        expect(got.attempts).toBe(3);
        expect(got.settled).toBe(false);
        expect(got.note).toBeUndefined(); // optional absent → NULL → absent
        expect(DateTime.formatIso(got.occurredAt)).toBe(DateTime.formatIso(at));
        expect(got.details).toEqual({ method: "card", last4: "4242" });
        expect(got.tags).toEqual(["retail", "eu"]);

        yield* store.upsert({
          ...p1,
          amount: 99,
          settled: true,
          note: "settled manually",
          details: { method: "sepa", last4: "0000" },
        });
        const updated = yield* store.get("p1");
        expect(updated.amount).toBe(99);
        expect(updated.settled).toBe(true);
        expect(updated.note).toBe("settled manually");
        expect(updated.details).toEqual({ method: "sepa", last4: "0000" });
        expect(yield* store.count()).toBe(1);
      }),
    );
  });

  test("findById missing → Option.none; get missing → NotFound with entity/id", async () => {
    await runWith(
      Effect.gen(function* () {
        const store = yield* paymentStore;
        expect(Option.isNone(yield* store.findById("nope"))).toBe(true);
        const error = yield* Effect.flip(store.get("nope"));
        expect(error._tag).toBe("NotFound");
        expect(error.entity).toBe("PaymentView");
        expect(error.id).toBe("nope");
        expect(error.classification).toBe("permanent");
      }),
    );
  });
});

const Item = ViewModel.define({
  name: "ItemView",
  table: "items",
  fields: {
    id: Schema.String,
    category: Schema.String,
    price: Schema.Number,
    active: Schema.Boolean,
  },
});
type Item = ViewModel.Of<typeof Item>;

const items: ReadonlyArray<Item> = [
  { id: "i1", category: "tools", price: 10, active: true },
  { id: "i2", category: "tools", price: 30, active: false },
  { id: "i3", category: "toys", price: 20, active: true },
  { id: "i4", category: "tools", price: 20, active: true },
];

const itemStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.unsafe(createTableSql(Item));
  const store = yield* ViewStore.make(Item);
  yield* store.upsertMany(items);
  return store;
});

describe("ViewStore.find", () => {
  test("equality criteria AND together (booleans included)", async () => {
    await runWith(
      Effect.gen(function* () {
        const store = yield* itemStore;
        const tools = yield* store.find({ category: "tools" });
        expect(tools.map((i) => i.id).sort()).toEqual(["i1", "i2", "i4"]);
        const activeTools = yield* store.find({ category: "tools", active: true });
        expect(activeTools.map((i) => i.id).sort()).toEqual(["i1", "i4"]);
        expect(yield* store.find({ category: "gone" })).toEqual([]);
      }),
    );
  });

  test("orderBy + limit/offset paging", async () => {
    await runWith(
      Effect.gen(function* () {
        const store = yield* itemStore;
        const desc = yield* store.find(undefined, { orderBy: "price", order: "desc" });
        expect(desc.map((i) => i.price)).toEqual([30, 20, 20, 10]);
        const page = yield* store.find(undefined, {
          orderBy: "id",
          limit: 2,
          offset: 1,
        });
        expect(page.map((i) => i.id)).toEqual(["i2", "i3"]);
        const offsetOnly = yield* store.find(undefined, { orderBy: "id", offset: 3 });
        expect(offsetOnly.map((i) => i.id)).toEqual(["i4"]);
      }),
    );
  });

  test("count and findOne", async () => {
    await runWith(
      Effect.gen(function* () {
        const store = yield* itemStore;
        expect(yield* store.count()).toBe(4);
        expect(yield* store.count({ category: "tools" })).toBe(3);
        expect(yield* store.count({ category: "none" })).toBe(0);
        const one = yield* store.findOne({ category: "toys" });
        expect(Option.isSome(one)).toBe(true);
        if (Option.isSome(one)) {
          expect(one.value.id).toBe("i3");
        }
        expect(Option.isNone(yield* store.findOne({ category: "none" }))).toBe(true);
      }),
    );
  });
});

describe("ViewStore patch/remove/truncate", () => {
  test("patch merges defined keys and fails NotFound on missing", async () => {
    await runWith(
      Effect.gen(function* () {
        const store = yield* itemStore;
        yield* store.patch("i1", { price: 42 });
        const patched = yield* store.get("i1");
        expect(patched.price).toBe(42);
        expect(patched.category).toBe("tools"); // untouched fields kept
        expect(patched.active).toBe(true);
        const error = yield* Effect.flip(store.patch("missing", { price: 1 }));
        expect(error._tag).toBe("NotFound");
        expect(error.id).toBe("missing");
      }),
    );
  });

  test("remove is idempotent; truncate empties the table", async () => {
    await runWith(
      Effect.gen(function* () {
        const store = yield* itemStore;
        yield* store.remove("i1");
        yield* store.remove("i1");
        expect(yield* store.count()).toBe(3);
        yield* store.truncate;
        expect(yield* store.count()).toBe(0);
        expect(Option.isNone(yield* store.findById("i2"))).toBe(true);
      }),
    );
  });
});
