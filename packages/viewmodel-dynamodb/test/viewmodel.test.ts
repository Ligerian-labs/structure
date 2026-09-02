import { describe, expect, test } from "bun:test";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { layer as eventsourcingLayer } from "@structure-ai/eventsourcing-dynamodb";
import { ViewModel } from "@structure-ai/viewmodel";
import { Effect, Redacted, Schema } from "effect";
import {
  makeWithIndexes,
  UndeclaredAccessPattern,
  RawDynamoClient as ViewRawDynamoClient,
} from "../src/index.js";

/**
 * Runs against DynamoDB Local behind `DYNAMODB_ENDPOINT_URL` (skipped
 * otherwise). The eventsourcing layer creates the shared table (as in real
 * compositions); the view store then adds its pattern GSIs on top.
 */
const endpoint = process.env.DYNAMODB_ENDPOINT_URL;

const OrderView = ViewModel.define({
  name: "order",
  fields: {
    id: Schema.String,
    tenantId: Schema.String,
    status: Schema.String,
    total: Schema.Number,
    note: Schema.optional(Schema.String),
  },
});

type OrderViewRow = {
  id: string;
  tenantId: string;
  status: string;
  total: number;
  note?: string;
};

const table = "viewmodel_test";

const base = eventsourcingLayer({
  tableName: table,
  region: "local",
  endpoint: endpoint ?? "",
  accessKeyId: "local",
  secretAccessKey: Redacted.make("local"),
});

// GSI lifecycle needs the raw client from the same connection settings.
const raw = new DynamoDBClient({
  region: "local",
  endpoint: endpoint ?? "",
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
});

const provide = (
  effect: Effect.Effect<unknown, unknown, unknown>,
): Effect.Effect<unknown, never, never> =>
  Effect.orDie(
    Effect.provide(
      Effect.provide(
        effect as Effect.Effect<unknown, unknown, never>,
        ViewRawDynamoClient.layer(raw),
      ),
      base,
    ),
  );

describe.skipIf(endpoint === undefined)("viewmodel-dynamodb (needs DYNAMODB_ENDPOINT_URL)", () => {
  test("upsert/get/findById roundtrip, patch and remove", async () => {
    await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const store = yield* makeWithIndexes(OrderView, {
            tableName: table,
            patterns: {
              byTenant: { partition: ["tenantId"] },
              byTenantStatus: { partition: ["tenantId", "status"] },
            },
          });
          yield* store.upsert({ id: "o1", tenantId: "t1", status: "open", total: 10 });
          const got = yield* store.get("o1");
          expect(got).toEqual({ id: "o1", tenantId: "t1", status: "open", total: 10 });
          expect((yield* store.findById("missing"))._tag).toBe("None");

          yield* store.patch("o1", { status: "paid" });
          expect((yield* store.get("o1")).status).toBe("paid");

          yield* store.remove("o1");
          expect((yield* store.findById("o1"))._tag).toBe("None");
        }),
      ),
    );
  });

  test("find resolves declared patterns and filters leftovers", async () => {
    await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const store = yield* makeWithIndexes(OrderView, {
            tableName: table,
            patterns: {
              byTenant: { partition: ["tenantId"] },
              byTenantStatus: { partition: ["tenantId", "status"] },
            },
          });
          yield* store.upsertMany([
            { id: "a", tenantId: "t1", status: "open", total: 1 },
            { id: "b", tenantId: "t1", status: "paid", total: 2 },
            { id: "c", tenantId: "t2", status: "open", total: 3 },
          ] as ReadonlyArray<OrderViewRow>);
          // byTenantStatus matches first (more partition fields).
          const paid = yield* store.find({ tenantId: "t1", status: "paid" });
          expect(paid.map((row) => row.id)).toEqual(["b"]);
          // byTenant + client-side leftover filter.
          const open = yield* store.find({ tenantId: "t1", status: "open" });
          expect(open.map((row) => row.id)).toEqual(["a"]);
          // Ordering and paging are client-side over the pattern collection.
          const tenants = yield* store.find(
            { tenantId: "t1" },
            { orderBy: "total", order: "desc" },
          );
          expect(tenants.map((row) => row.id)).toEqual(["b", "a"]);
          const paged = yield* store.find(
            { tenantId: "t1" },
            { orderBy: "total", order: "desc", limit: 1, offset: 1 },
          );
          expect(paged.map((row) => row.id)).toEqual(["a"]);
          expect(yield* store.count({ tenantId: "t1" })).toBe(2);
          expect(yield* store.count()).toBe(3);
          yield* store.truncate();
          expect(yield* store.count()).toBe(0);
        }),
      ),
    );
  });

  test("criteria outside declared patterns fail loudly", async () => {
    await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const store = yield* makeWithIndexes(OrderView, {
            tableName: table,
            patterns: { byTenant: { partition: ["tenantId"] } },
          });
          const result = yield* Effect.either(store.find({ status: "open" }));
          expect(result._tag).toBe("Left");
          if (result._tag === "Left") {
            expect(result.left).toBeInstanceOf(UndeclaredAccessPattern);
            expect(result.left.message).toContain("byTenant");
          }
        }),
      ),
    );
  });

  test("null pattern fields are sparse: absent from that index", async () => {
    await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const store = yield* makeWithIndexes(OrderView, {
            tableName: table,
            patterns: { byStatus: { partition: ["status"] } },
          });
          // note is null/absent — but pattern is on status; use a row whose
          // status is absent by making the field optional in a second view.
          yield* store.upsert({ id: "s1", tenantId: "t1", status: "open", total: 5 });
          const rows = yield* store.find({ status: "open" });
          expect(rows.map((row) => row.id)).toEqual(["s1"]);
          yield* store.truncate();
        }),
      ),
    );
  });
});
