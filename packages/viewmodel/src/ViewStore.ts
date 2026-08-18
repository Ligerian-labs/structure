import { SqlClient } from "@effect/sql/SqlClient";
import type { Fragment } from "@effect/sql/Statement";
import { NotFound } from "@structure/domain";
import { type Context, Effect, Layer, Option, Schema } from "effect";
import type { ColumnSpec, ViewModelDef } from "./ViewModel.js";

/** Options for {@link ViewStore.find}: ordering and paging. */
export interface FindOptions<Encoded> {
  /** Field (not column) to order by; unknown fields are ignored. */
  readonly orderBy?: keyof Encoded & string;
  /** Sort direction, default `"asc"`. */
  readonly order?: "asc" | "desc";
  /** Maximum number of rows returned. */
  readonly limit?: number;
  /**
   * Rows to skip. Usable without `limit` (a maximal limit is emitted, since
   * SQLite requires `LIMIT` before `OFFSET`), but pair it with `limit` and an
   * `orderBy` for deterministic paging.
   */
  readonly offset?: number;
}

/**
 * Typed store over one view-model table. All methods capture the `SqlClient`
 * at construction and require nothing further.
 *
 * Error semantics: business-level absence is typed (`NotFound`); SQL errors
 * and row-codec failures are defects — a read model failing to decode its
 * own rows is corruption, not a runtime condition (rebuild it from events).
 *
 * Concurrency: a view table has a single writer — its hydrating projection.
 * The store performs no locking or optimistic checks.
 */
export interface ViewStore<A, Encoded = A> {
  /** The row with this id, or `NotFound` (entity = the view model's name). */
  readonly get: (id: string | number) => Effect.Effect<A, NotFound>;
  /** The row with this id as an `Option`. */
  readonly findById: (id: string | number) => Effect.Effect<Option.Option<A>>;
  /**
   * Rows matching `criteria` — an equality-AND over fields, compared on
   * encoded values (`null` matches SQL `NULL`) — with optional ordering and
   * paging. No criteria returns every row.
   */
  readonly find: (
    criteria?: Partial<Encoded>,
    options?: FindOptions<Encoded>,
  ) => Effect.Effect<ReadonlyArray<A>>;
  /** First row matching `criteria` (no implied ordering). */
  readonly findOne: (criteria: Partial<Encoded>) => Effect.Effect<Option.Option<A>>;
  /** Number of rows matching `criteria` (all rows when omitted). */
  readonly count: (criteria?: Partial<Encoded>) => Effect.Effect<number>;
  /** Inserts the row, or replaces every non-id column when the id exists. */
  readonly upsert: (value: A) => Effect.Effect<void>;
  /** Upserts each value in order. */
  readonly upsertMany: (values: ReadonlyArray<A>) => Effect.Effect<void>;
  /**
   * Read-modify-write: loads the row, overlays the defined keys of
   * `partial`, and upserts the result. NOT atomic — safe only because a view
   * table has a single writer (the projection).
   */
  readonly patch: (id: string | number, partial: Partial<A>) => Effect.Effect<void, NotFound>;
  /** Deletes the row; deleting a missing id is a no-op (idempotent). */
  readonly remove: (id: string | number) => Effect.Effect<void>;
  /** Deletes every row (`DELETE FROM table`) — used by rebuilds. */
  readonly truncate: Effect.Effect<void>;
}

type ColumnValue = string | number | boolean | null;

const coerceBoolean = (raw: unknown): unknown => {
  if (typeof raw === "boolean") {
    return raw;
  }
  if (typeof raw === "number" || typeof raw === "bigint") {
    return Number(raw) !== 0;
  }
  if (raw === "true" || raw === "t" || raw === "1") {
    return true;
  }
  if (raw === "false" || raw === "f" || raw === "0") {
    return false;
  }
  return raw;
};

const coerceNumber = (raw: unknown): unknown => {
  if (typeof raw === "bigint") {
    return Number(raw);
  }
  if (typeof raw === "string" && raw.trim() !== "" && !Number.isNaN(Number(raw))) {
    return Number(raw);
  }
  return raw;
};

/**
 * Lenient pre-decode normalization: drivers disagree on scalar shapes
 * (SQLite returns booleans as 0/1, PostgreSQL may return numbers as
 * strings). Normalized values then pass through the schema for the real
 * validation.
 */
const normalize = (column: ColumnSpec, raw: unknown): unknown => {
  if (column.json) {
    return JSON.parse(String(raw)) as unknown;
  }
  switch (column.sqlType) {
    case "BOOLEAN":
      return coerceBoolean(raw);
    case "INTEGER":
    case "DOUBLE PRECISION":
      return coerceNumber(raw);
    case "TEXT":
      return raw;
  }
};

/**
 * Builds a {@link ViewStore} for a view model, capturing the `SqlClient`
 * from the context. The table must already exist (see
 * `ViewModel.migration`). Rows encode/decode through the definition's
 * schema; JSON-class columns are stringified/parsed transparently.
 */
export const make = <Fields extends Schema.Struct.Fields>(
  def: ViewModelDef<Fields>,
): Effect.Effect<
  ViewStore<
    Schema.Schema.Type<Schema.Struct<Fields>>,
    Schema.Schema.Encoded<Schema.Struct<Fields>>
  >,
  never,
  SqlClient
> =>
  Effect.map(SqlClient, (sql) => {
    type A = Schema.Schema.Type<Schema.Struct<Fields>>;
    type Encoded = Schema.Schema.Encoded<Schema.Struct<Fields>>;

    // View-model fields are context-free by contract (see `ViewModel.define`);
    // a schema that violates it fails here as a defect.
    const codec = def.schema as unknown as Schema.Schema<A, Record<string, unknown>, never>;
    const encode = Schema.encodeSync(codec);
    const decode = Schema.decodeUnknownSync(codec);

    const byField = new Map(def.columns.map((c) => [c.field, c]));
    const nonIdColumns = def.columns.filter((c) => c.column !== def.idColumn);
    const empty = sql.literal("");

    const toColumnValue = (column: ColumnSpec, value: unknown): ColumnValue => {
      if (value === undefined || value === null) {
        return null;
      }
      if (column.json) {
        return JSON.stringify(value);
      }
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return value;
      }
      // Non-JSON columns hold encoded scalars by construction; anything else
      // is stored by its string form as a last resort.
      return String(value);
    };

    const toRow = (value: A): Record<string, ColumnValue> => {
      const encoded = encode(value);
      const row: Record<string, ColumnValue> = {};
      for (const column of def.columns) {
        row[column.column] = toColumnValue(column, encoded[column.field]);
      }
      return row;
    };

    const fromRow = (row: Record<string, unknown>): A => {
      const record: Record<string, unknown> = {};
      for (const column of def.columns) {
        const raw = row[column.column];
        if (raw === null || raw === undefined) {
          // SQL NULL: an optional field reads back as an absent key, a
          // required (nullable) field as null.
          if (!column.optional) {
            record[column.field] = null;
          }
          continue;
        }
        record[column.field] = normalize(column, raw);
      }
      return decode(record);
    };

    const decodeMany = (
      rows: ReadonlyArray<Record<string, unknown>>,
    ): Effect.Effect<ReadonlyArray<A>> => Effect.try(() => rows.map(fromRow)).pipe(Effect.orDie);

    const whereFragment = (criteria: Partial<Encoded> | undefined): Fragment => {
      if (criteria === undefined) {
        return empty;
      }
      const record = criteria as Record<string, unknown>;
      const clauses: Array<Fragment> = [];
      for (const column of def.columns) {
        if (!Object.hasOwn(record, column.field)) {
          continue;
        }
        const value = record[column.field];
        if (value === undefined) {
          continue;
        }
        const columnValue = toColumnValue(column, value);
        clauses.push(
          columnValue === null
            ? sql`${sql(column.column)} IS NULL`
            : sql`${sql(column.column)} = ${columnValue}`,
        );
      }
      return clauses.length === 0 ? empty : sql` WHERE ${sql.and(clauses)}`;
    };

    const orderFragment = (options: FindOptions<Encoded> | undefined): Fragment => {
      const orderBy = options?.orderBy;
      if (orderBy === undefined) {
        return empty;
      }
      const column = byField.get(orderBy);
      if (column === undefined) {
        return empty;
      }
      const direction = options?.order === "desc" ? "DESC" : "ASC";
      return sql` ORDER BY ${sql(column.column)} ${sql.literal(direction)}`;
    };

    const limitFragment = (options: FindOptions<Encoded> | undefined): Fragment => {
      const limit =
        options?.limit ?? (options?.offset !== undefined ? Number.MAX_SAFE_INTEGER : undefined);
      if (limit === undefined) {
        return empty;
      }
      const offset = options?.offset;
      return offset === undefined ? sql` LIMIT ${limit}` : sql` LIMIT ${limit} OFFSET ${offset}`;
    };

    const select = (
      criteria: Partial<Encoded> | undefined,
      options: FindOptions<Encoded> | undefined,
    ): Effect.Effect<ReadonlyArray<Record<string, unknown>>> =>
      sql<
        Record<string, unknown>
      >`SELECT * FROM ${sql(def.table)}${whereFragment(criteria)}${orderFragment(options)}${limitFragment(options)}`.pipe(
        Effect.orDie,
      );

    const find = (
      criteria?: Partial<Encoded>,
      options?: FindOptions<Encoded>,
    ): Effect.Effect<ReadonlyArray<A>> => Effect.flatMap(select(criteria, options), decodeMany);

    const findById = (id: string | number): Effect.Effect<Option.Option<A>> =>
      sql<
        Record<string, unknown>
      >`SELECT * FROM ${sql(def.table)} WHERE ${sql(def.idColumn)} = ${id}`.pipe(
        Effect.orDie,
        Effect.flatMap((rows) => {
          const first = rows[0];
          return first === undefined
            ? Effect.succeed(Option.none<A>())
            : Effect.try(() => Option.some(fromRow(first))).pipe(Effect.orDie);
        }),
      );

    const get = (id: string | number): Effect.Effect<A, NotFound> =>
      Effect.flatMap(
        findById(id),
        Option.match({
          onNone: () => Effect.fail(new NotFound({ entity: def.name, id: String(id) })),
          onSome: Effect.succeed,
        }),
      );

    const upsert = (value: A): Effect.Effect<void> =>
      Effect.flatMap(Effect.orDie(Effect.try(() => toRow(value))), (row) =>
        nonIdColumns.length === 0
          ? sql`INSERT INTO ${sql(def.table)} ${sql.insert(row)} ON CONFLICT (${sql(def.idColumn)}) DO NOTHING`
          : sql`INSERT INTO ${sql(def.table)} ${sql.insert(row)} ON CONFLICT (${sql(def.idColumn)}) DO UPDATE SET ${sql.csv(
              nonIdColumns.map((c) => sql`${sql(c.column)} = excluded.${sql(c.column)}`),
            )}`,
      ).pipe(Effect.orDie, Effect.asVoid);

    const store: ViewStore<A, Encoded> = {
      get,
      findById,
      find,
      findOne: (criteria) =>
        Effect.map(find(criteria, { limit: 1 }), (rows) => Option.fromNullable(rows[0])),
      count: (criteria?) =>
        sql<{
          readonly n: unknown;
        }>`SELECT count(*) AS n FROM ${sql(def.table)}${whereFragment(criteria)}`.pipe(
          Effect.orDie,
          Effect.map((rows) => Number(rows[0]?.n ?? 0)),
        ),
      upsert,
      upsertMany: (values) => Effect.forEach(values, upsert, { discard: true }),
      patch: (id, partial) =>
        Effect.flatMap(get(id), (current) => {
          const merged: Record<string, unknown> = {
            ...(current as unknown as Record<string, unknown>),
          };
          for (const [key, value] of Object.entries(partial as Record<string, unknown>)) {
            if (value !== undefined) {
              merged[key] = value;
            }
          }
          return upsert(merged as unknown as A);
        }),
      remove: (id) =>
        sql`DELETE FROM ${sql(def.table)} WHERE ${sql(def.idColumn)} = ${id}`.pipe(
          Effect.orDie,
          Effect.asVoid,
        ),
      truncate: sql`DELETE FROM ${sql(def.table)}`.pipe(Effect.orDie, Effect.asVoid),
    };
    return store;
  });

/**
 * The store as a service: `Layer.effect(tag, make(def))`, for applications
 * that prefer resolving stores from the context over constructing them at
 * call sites.
 */
export const layer = <Self, Fields extends Schema.Struct.Fields>(
  tag: Context.Tag<
    Self,
    ViewStore<
      Schema.Schema.Type<Schema.Struct<Fields>>,
      Schema.Schema.Encoded<Schema.Struct<Fields>>
    >
  >,
  def: ViewModelDef<Fields>,
): Layer.Layer<Self, never, SqlClient> => Layer.effect(tag, make(def));
