import {
  type CreateGlobalSecondaryIndexAction,
  DescribeTableCommand,
  type DynamoDBClient,
  UpdateTableCommand,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentService } from "@effect-aws/dynamodb";
import { NotFound } from "@structure-ai/domain";
import type { ViewModelDef } from "@structure-ai/viewmodel";
import { Context, Data, Effect, Layer, Option, Schema } from "effect";

const describeError = (error: unknown): string => {
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
};

/**
 * ViewStore over the DynamoDB single table (ADR-0015). DynamoDB answers
 * designed access patterns, not ad-hoc queries — so every `find` criteria
 * must match a **declared access pattern**: a set of partition fields plus
 * optional sort fields, materialized as a sparse composite-key GSI on the
 * shared table (book ch. 11.3, 13.3, 13.4). Rows whose pattern fields are
 * null/absent simply leave the index. Criteria outside declared patterns
 * fail loudly with {@link UndeclaredAccessPattern} — that is the contract:
 * design the query, don't hope for a scan.
 *
 * Items: pk `V#<viewName>#<id>`, sk `V`, one attribute per declared pattern
 * holding its joined key parts. `find` sorts and pages client-side over the
 * pattern's item collection (bounded by your data, documented cost).
 */

/** A declared access pattern: partition fields (equality-AND) + optional sort fields. */
export interface AccessPattern {
  readonly partition: ReadonlyArray<string>;
  readonly sort?: ReadonlyArray<string>;
}

/** Options for {@link make}. */
export interface DdbViewStoreOptions {
  /** The shared table name (same table as the eventsourcing adapters). */
  readonly tableName: string;
  /** Declared access patterns, by name; each becomes a GSI on the table. */
  readonly patterns: Readonly<Record<string, AccessPattern>>;
}

/** The query shape does not match any declared access pattern (permanent). */
export class UndeclaredAccessPattern extends Data.TaggedError("UndeclaredAccessPattern")<{
  readonly classification: "permanent";
  readonly message: string;
}> {}

// --- key encoding -----------------------------------------------------------------

const encodePart = (value: unknown): string | undefined => {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return `s#${value}`;
  if (typeof value === "number")
    return `n#${value >= 0 ? "+" : "-"}${Math.abs(value).toString().padStart(20, "0")}`;
  if (typeof value === "boolean") return `b#${value ? "1" : "0"}`;
  return `j#${JSON.stringify(value)}`;
};

const patternKey = (parts: ReadonlyArray<string | undefined>): string | undefined => {
  const present = parts.filter((part): part is string => part !== undefined);
  if (present.length !== parts.length || present.length === 0) return undefined;
  return present.join("#");
};

const patternAttribute = (viewName: string, patternName: string, kind: "pk" | "sk"): string =>
  `vm_${viewName}_${patternName}_${kind}`;

const gsiName = (viewName: string, patternName: string): string => `vm-${viewName}-${patternName}`;

// --- pattern resolution --------------------------------------------------------------

const resolvePattern = <Encoded>(
  patterns: Readonly<Record<string, AccessPattern>>,
  criteria: Partial<Encoded>,
  orderBy?: string,
): { readonly name: string; readonly pattern: AccessPattern } | undefined => {
  const keys = new Set(
    Object.entries(criteria)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key]) => key),
  );
  const candidates = Object.entries(patterns)
    .filter(([, pattern]) => pattern.partition.every((field) => keys.has(field)))
    // Prefer the most specific partition; tie-break on sort covering orderBy.
    .sort((a, b) => {
      const byLen = b[1].partition.length - a[1].partition.length;
      if (byLen !== 0) return byLen;
      const covers = (pattern: AccessPattern): number =>
        orderBy !== undefined && (pattern.sort ?? []).includes(orderBy) ? 1 : 0;
      return covers(b[1]) - covers(a[1]);
    });
  return candidates[0] === undefined
    ? undefined
    : { name: candidates[0][0], pattern: candidates[0][1] };
};

// --- the store -------------------------------------------------------------------------

/** What the store needs: the document client for data, the raw client for GSI lifecycle. */
export class RawDynamoClient extends Context.Tag(
  "@structure-ai/viewmodel-dynamodb/RawDynamoClient",
)<RawDynamoClient, DynamoDBClient>() {
  static readonly layer = (client: DynamoDBClient): Layer.Layer<RawDynamoClient> =>
    Layer.succeed(RawDynamoClient, client);
}

/**
 * Idempotently ensures one GSI per declared access pattern exists on the
 * shared table (adds missing ones via `UpdateTable`, waits for ACTIVE).
 */
export const ensureViewIndexes = (
  options: DdbViewStoreOptions,
  viewName: string,
): Effect.Effect<void, Error, RawDynamoClient> =>
  Effect.gen(function* () {
    const client = yield* RawDynamoClient;
    const described = yield* Effect.tryPromise({
      try: () => client.send(new DescribeTableCommand({ TableName: options.tableName })),
      catch: (error) => new Error(String(error)),
    });
    const present = new Set(
      (described.Table?.GlobalSecondaryIndexes ?? []).map((index) => index.IndexName),
    );
    const missing: Array<CreateGlobalSecondaryIndexAction> = [];
    const attributeDefinitions: Array<{ AttributeName: string; AttributeType: "S" }> = [];
    for (const [patternName] of Object.entries(options.patterns)) {
      if (present.has(gsiName(viewName, patternName))) continue;
      const pk = patternAttribute(viewName, patternName, "pk");
      const sk = patternAttribute(viewName, patternName, "sk");
      missing.push({
        IndexName: gsiName(viewName, patternName),
        KeySchema: [
          { AttributeName: pk, KeyType: "HASH" },
          { AttributeName: sk, KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
      });
      attributeDefinitions.push(
        { AttributeName: pk, AttributeType: "S" },
        { AttributeName: sk, AttributeType: "S" },
      );
    }
    if (missing.length === 0) return;
    // DynamoDB builds one online index at a time: create each GSI in its own
    // UpdateTable and wait for ACTIVE before the next.
    for (const [position, index] of missing.entries()) {
      yield* Effect.tryPromise({
        try: () =>
          client.send(
            new UpdateTableCommand({
              TableName: options.tableName,
              AttributeDefinitions: [
                attributeDefinitions[position * 2],
                attributeDefinitions[position * 2 + 1],
              ].filter(
                (definition): definition is { AttributeName: string; AttributeType: "S" } =>
                  definition !== undefined,
              ),
              GlobalSecondaryIndexUpdates: [{ Create: index }],
            }),
          ),
        catch: (error) => new Error(String(error)),
      });
      yield* Effect.iterate(0, {
        while: (attempt) => attempt < 100,
        body: (attempt) =>
          Effect.flatMap(
            Effect.tryPromise({
              try: () => client.send(new DescribeTableCommand({ TableName: options.tableName })),
              catch: (error) => new Error(String(error)),
            }),
            (next): Effect.Effect<number> => {
              const created = (next.Table?.GlobalSecondaryIndexes ?? []).find(
                (candidate) => candidate.IndexName === index.IndexName,
              );
              return created?.IndexStatus === "ACTIVE"
                ? Effect.succeed(100)
                : Effect.zipRight(Effect.sleep("100 millis"), Effect.succeed(attempt + 1));
            },
          ),
      });
    }
  });

/** Builds a {@link DdbViewStore} over the shared DynamoDB table. */
export const make = <Fields extends Schema.Struct.Fields>(
  def: ViewModelDef<Fields>,
  options: DdbViewStoreOptions,
): Effect.Effect<
  DdbViewStore<
    Schema.Schema.Type<Schema.Struct<Fields>>,
    Schema.Schema.Encoded<Schema.Struct<Fields>>
  >,
  never,
  DynamoDBDocumentService
> =>
  Effect.map(DynamoDBDocumentService, (ddb) => {
    type A = Schema.Schema.Type<Schema.Struct<Fields>>;
    type Encoded = Schema.Schema.Encoded<Schema.Struct<Fields>>;
    const viewName = def.name;
    const table = options.tableName;

    // View-model fields are context-free by contract (see `ViewModel.define`);
    // a schema that violates it fails here as a defect.
    const codec = def.schema as unknown as Schema.Schema<A, Record<string, unknown>, never>;

    const itemKey = (id: string | number) => ({
      pk: `V#${viewName}#${String(id)}`,
      sk: "V",
    });

    const decodeRow = (item: Record<string, unknown>): A | undefined => {
      try {
        return Schema.decodeUnknownSync(codec)(item);
      } catch {
        return undefined;
      }
    };

    const patternAttributes = (encoded: Record<string, unknown>): Record<string, string> => {
      const attributes: Record<string, string> = {};
      for (const [patternName, pattern] of Object.entries(options.patterns)) {
        const pk = patternKey(pattern.partition.map((field) => encodePart(encoded[field])));
        const sk =
          pattern.sort === undefined || pattern.sort.length === 0
            ? "s#" // DynamoDB forbids empty index-key values; a fixed sentinel
            : // stands in when a pattern declares no sort fields.
              patternKey(pattern.sort.map((field) => encodePart(encoded[field])));
        if (pk !== undefined) {
          attributes[patternAttribute(viewName, patternName, "pk")] = pk;
          attributes[patternAttribute(viewName, patternName, "sk")] = sk ?? "s#";
        }
      }
      return attributes;
    };

    const failUndeclared = (criteria: Partial<Encoded>): UndeclaredAccessPattern =>
      new UndeclaredAccessPattern({
        classification: "permanent",
        message: `find(${JSON.stringify(criteria)}) matches no declared access pattern of "${viewName}"; declared: ${Object.entries(
          options.patterns,
        )
          .map(([name, pattern]) => `${name}(partition: [${pattern.partition.join(", ")}])`)
          .join("; ")}`,
      });

    const fetchMatching = (
      criteria: Partial<Encoded>,
    ): Effect.Effect<ReadonlyArray<A>, UndeclaredAccessPattern> => {
      const criteriaKeys = Object.keys(criteria).filter(
        (key) => (criteria as Record<string, unknown>)[key] !== undefined,
      );
      if (criteriaKeys.length === 0) {
        // No criteria: every row of the view (Scan over the pk prefix).
        return ddb
          .scan({
            TableName: table,
            FilterExpression: "begins_with(#pk, :prefix)",
            ExpressionAttributeNames: { "#pk": "pk" },
            ExpressionAttributeValues: { ":prefix": `V#${viewName}#` },
          })
          .pipe(
            Effect.map((output) =>
              (output.Items ?? []).flatMap((item) => {
                const row = decodeRow(item);
                return row === undefined ? [] : [row];
              }),
            ),
            Effect.catchAll((error) => Effect.die(new Error(describeError(error)))),
          );
      }
      const resolved = resolvePattern(options.patterns, criteria);
      if (resolved === undefined) return Effect.fail(failUndeclared(criteria));
      const encoded = criteria as Record<string, unknown>;
      const pk = patternKey(resolved.pattern.partition.map((field) => encodePart(encoded[field])));
      if (pk === undefined) return Effect.fail(failUndeclared(criteria));
      const leftover = criteriaKeys.filter((key) => !resolved.pattern.partition.includes(key));
      return ddb
        .query({
          TableName: table,
          IndexName: gsiName(viewName, resolved.name),
          KeyConditionExpression: "#pk = :pk",
          ExpressionAttributeNames: { "#pk": patternAttribute(viewName, resolved.name, "pk") },
          ExpressionAttributeValues: { ":pk": pk },
        })
        .pipe(
          Effect.map((output) =>
            (output.Items ?? [])
              .filter((item) => {
                if (leftover.length === 0) return true;
                return leftover.every((field) => {
                  const expected = encoded[field];
                  const actual = (item as Record<string, unknown>)[field];
                  return JSON.stringify(actual) === JSON.stringify(expected);
                });
              })
              .flatMap((item) => {
                const row = decodeRow(item);
                return row === undefined ? [] : [row];
              }),
          ),
          Effect.catchAll((error) => Effect.die(new Error(describeError(error)))),
        );
    };

    const encodeRow = (value: A): Record<string, unknown> => {
      const encoded = Schema.encodeSync(codec)(value) as Record<string, unknown>;
      return { ...itemKey(String(encoded[def.idField])), entity: "view", ...encoded };
    };

    return {
      get: (id) =>
        ddb.get({ TableName: table, Key: itemKey(id), ConsistentRead: true }).pipe(
          Effect.flatMap((output) => {
            const row = output.Item === undefined ? undefined : decodeRow(output.Item);
            return row === undefined
              ? Effect.fail(new NotFound({ entity: viewName, id: String(id) }))
              : Effect.succeed(row);
          }),
          Effect.catchAll((error) => Effect.die(new Error(describeError(error)))),
        ),
      findById: (id) =>
        ddb.get({ TableName: table, Key: itemKey(id), ConsistentRead: true }).pipe(
          Effect.map((output) =>
            Option.fromNullable(output.Item === undefined ? undefined : decodeRow(output.Item)),
          ),
          Effect.catchAll((error) => Effect.die(new Error(describeError(error)))),
        ),
      find: (criteria, findOptions) =>
        Effect.map(fetchMatching(criteria ?? {}), (rows) => {
          const sorted =
            findOptions?.orderBy === undefined
              ? [...rows]
              : [...rows].sort((a, b) => {
                  const key = findOptions.orderBy as string;
                  const av = (a as Record<string, unknown>)[key];
                  const bv = (b as Record<string, unknown>)[key];
                  const compared = av === bv ? 0 : String(av) > String(bv) ? 1 : -1;
                  return findOptions.order === "desc" ? -compared : compared;
                });
          const offset = findOptions?.offset ?? 0;
          const limit = findOptions?.limit;
          const sliced = sorted.slice(offset, limit === undefined ? undefined : offset + limit);
          return sliced;
        }),
      findOne: (criteria) =>
        Effect.map(fetchMatching(criteria), (rows) => Option.fromNullable(rows[0])),
      count: (criteria) => Effect.map(fetchMatching(criteria ?? {}), (rows) => rows.length),
      upsert: (value) =>
        ddb
          .put({
            TableName: table,
            Item: { ...encodeRow(value), ...patternAttributes(encodeRow(value)) },
          })
          .pipe(
            Effect.asVoid,
            Effect.catchAll((error) => Effect.die(new Error(describeError(error)))),
          ),
      upsertMany: (values) =>
        Effect.forEach(
          values,
          (value) =>
            ddb
              .put({
                TableName: table,
                Item: { ...encodeRow(value), ...patternAttributes(encodeRow(value)) },
              })
              .pipe(
                Effect.asVoid,
                Effect.catchAll((error) => Effect.die(new Error(describeError(error)))),
              ),
          { discard: true },
        ),
      patch: (id, partial) =>
        ddb.get({ TableName: table, Key: itemKey(id), ConsistentRead: true }).pipe(
          Effect.flatMap((output) => {
            const row = output.Item === undefined ? undefined : decodeRow(output.Item);
            if (row === undefined) {
              return Effect.fail(new NotFound({ entity: viewName, id: String(id) }));
            }
            const merged = { ...row, ...partial } as A;
            return ddb
              .put({
                TableName: table,
                Item: { ...encodeRow(merged), ...patternAttributes(encodeRow(merged)) },
              })
              .pipe(Effect.asVoid) as unknown as Effect.Effect<void, NotFound>;
          }),
          Effect.catchAll((error) => Effect.die(new Error(describeError(error)))),
        ),
      remove: (id) =>
        ddb.delete({ TableName: table, Key: itemKey(id) }).pipe(
          Effect.asVoid,
          Effect.catchAll((error) => Effect.die(new Error(describeError(error)))),
        ),
      truncate: () =>
        ddb
          .scan({
            TableName: table,
            FilterExpression: "begins_with(#pk, :prefix)",
            ExpressionAttributeNames: { "#pk": "pk" },
            ExpressionAttributeValues: { ":prefix": `V#${viewName}#` },
          })
          .pipe(
            Effect.flatMap(
              (output) =>
                Effect.forEach(
                  output.Items ?? [],
                  (item) =>
                    ddb
                      .delete({ TableName: table, Key: { pk: item.pk, sk: "V" } })
                      .pipe(Effect.asVoid),
                  { discard: true },
                ) as Effect.Effect<void>,
            ),
            Effect.catchAll((error) => Effect.die(new Error(describeError(error)))),
          ) as Effect.Effect<void>,
    };
  });

/** The DynamoDB flavor of the ViewStore port (same method surface). */
export interface DdbViewStore<A, Encoded = A> {
  readonly get: (id: string | number) => Effect.Effect<A, NotFound>;
  readonly findById: (id: string | number) => Effect.Effect<Option.Option<A>>;
  readonly find: (
    criteria?: Partial<Encoded>,
    options?: { orderBy?: string; order?: "asc" | "desc"; limit?: number; offset?: number },
  ) => Effect.Effect<ReadonlyArray<A>, UndeclaredAccessPattern>;
  readonly findOne: (
    criteria: Partial<Encoded>,
  ) => Effect.Effect<Option.Option<A>, UndeclaredAccessPattern>;
  readonly count: (criteria?: Partial<Encoded>) => Effect.Effect<number, UndeclaredAccessPattern>;
  readonly upsert: (value: A) => Effect.Effect<void>;
  readonly upsertMany: (values: ReadonlyArray<A>) => Effect.Effect<void>;
  readonly patch: (id: string | number, partial: Partial<A>) => Effect.Effect<void, NotFound>;
  readonly remove: (id: string | number) => Effect.Effect<void>;
  readonly truncate: () => Effect.Effect<void>;
}

/** `make` with GSI lifecycle: ensures the pattern indexes exist, then builds the store. */
export const makeWithIndexes = <Fields extends Schema.Struct.Fields>(
  def: ViewModelDef<Fields>,
  options: DdbViewStoreOptions,
): Effect.Effect<
  DdbViewStore<
    Schema.Schema.Type<Schema.Struct<Fields>>,
    Schema.Schema.Encoded<Schema.Struct<Fields>>
  >,
  Error,
  DynamoDBDocumentService | RawDynamoClient
> => Effect.andThen(ensureViewIndexes(options, def.name), make(def, options));
