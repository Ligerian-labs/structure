import { describe, expect, test } from "bun:test";
import * as SqlClient from "@effect/sql/SqlClient";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { makeSet, run } from "@structure/migrations";
import { Effect, Schema } from "effect";
import { columnName, createTableSql, InvalidViewModel, ViewModel } from "../src/index.js";

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

describe("ViewModel.define", () => {
  test("defaults: snake_case table, id field, snake_case columns", () => {
    expect(Payment.name).toBe("PaymentView");
    expect(Payment.table).toBe("payment_view");
    expect(Payment.idField).toBe("id");
    expect(Payment.idColumn).toBe("id");
    expect(Payment.columns.map((c) => c.column)).toEqual([
      "id",
      "amount",
      "attempts",
      "settled",
      "note",
      "occurred_at",
      "details",
      "tags",
    ]);
    expect(columnName("occurredAt")).toBe("occurred_at");
  });

  test("storage classes cover every mapping", () => {
    const byField = new Map(Payment.columns.map((c) => [c.field, c]));
    expect(byField.get("id")).toMatchObject({ sqlType: "TEXT", json: false, nullable: false });
    expect(byField.get("amount")).toMatchObject({ sqlType: "DOUBLE PRECISION", json: false });
    expect(byField.get("attempts")).toMatchObject({ sqlType: "INTEGER", json: false });
    expect(byField.get("settled")).toMatchObject({ sqlType: "BOOLEAN", json: false });
    expect(byField.get("note")).toMatchObject({
      sqlType: "TEXT",
      json: false,
      nullable: true,
      optional: true,
    });
    expect(byField.get("occurredAt")).toMatchObject({ sqlType: "TEXT", json: false });
    expect(byField.get("details")).toMatchObject({ sqlType: "TEXT", json: true });
    expect(byField.get("tags")).toMatchObject({ sqlType: "TEXT", json: true });
  });

  test("throws InvalidViewModel listing every problem", () => {
    expect(() =>
      ViewModel.define({
        name: "Broken",
        fields: { key: Schema.String },
      }),
    ).toThrow(InvalidViewModel);
    try {
      ViewModel.define({
        name: "Broken",
        fields: { fooBar: Schema.String, foo_bar: Schema.String },
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidViewModel);
      if (error instanceof InvalidViewModel) {
        expect(error.classification).toBe("permanent");
        // missing id field + column collision
        expect(error.problems.length).toBe(2);
      }
    }
  });
});

describe("createTableSql / migration", () => {
  test("DDL contains every column with its type and the primary key", () => {
    const ddl = createTableSql(Payment);
    expect(ddl).toStartWith("CREATE TABLE IF NOT EXISTS payment_view (");
    expect(ddl).toContain("id TEXT NOT NULL");
    expect(ddl).toContain("amount DOUBLE PRECISION NOT NULL");
    expect(ddl).toContain("attempts INTEGER NOT NULL");
    expect(ddl).toContain("settled BOOLEAN NOT NULL");
    expect(ddl).toContain("note TEXT,"); // nullable: no NOT NULL
    expect(ddl).not.toContain("note TEXT NOT NULL");
    expect(ddl).toContain("occurred_at TEXT NOT NULL");
    expect(ddl).toContain("details TEXT NOT NULL");
    expect(ddl).toContain("tags TEXT NOT NULL");
    expect(ddl).toContain("PRIMARY KEY (id)");
  });

  test("ViewModel.migration runs through @structure/migrations and creates the table", async () => {
    const set = makeSet([ViewModel.migration(Payment, 1)]);
    const program = Effect.gen(function* () {
      const applied = yield* run(set);
      expect(applied).toEqual([[1, "create_payment_view"]]);
      const sql = yield* SqlClient.SqlClient;
      const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${Payment.table}
      `;
      expect(tables).toHaveLength(1);
      const again = yield* run(set);
      expect(again).toHaveLength(0);
    });
    await Effect.runPromise(program.pipe(Effect.provide(sqlite()), Effect.scoped));
  });
});
