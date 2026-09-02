import { SqlClient } from "@effect/sql/SqlClient";
import { defineMigration, type Migration } from "@structure-ai/migrations";
import { Data, Effect, Option, Schema } from "effect";
import * as AST from "effect/SchemaAST";

/**
 * A view model definition is invalid: the id field is missing from the
 * fields, or two fields map to the same column name. Raised (thrown) at
 * definition time — this is a programming error, not a runtime condition.
 * Permanent: retrying cannot help.
 */
export class InvalidViewModel extends Data.TaggedError("InvalidViewModel")<{
  readonly view: string;
  readonly problems: ReadonlyArray<string>;
}> {
  /** Failure classification per the production contract. */
  readonly classification = "permanent" as const;
  override get message(): string {
    return `view model "${this.view}" is invalid:\n${this.problems.map((p) => `  - ${p}`).join("\n")}`;
  }
}

/**
 * SQL storage class of one column. The mapping is deliberately small and
 * uses type names valid in both PostgreSQL and SQLite (SQLite accepts any
 * type name):
 *
 * | Field schema (per field)                     | Column type        |
 * | -------------------------------------------- | ------------------ |
 * | string, string literals/unions, templates    | `TEXT`             |
 * | number                                       | `DOUBLE PRECISION` |
 * | `Schema.Int` / int-refined numbers           | `INTEGER`          |
 * | boolean                                      | `BOOLEAN`          |
 * | `DateTimeUtc`, `Date` (string-encoded)       | `TEXT` (ISO string)|
 * | everything else (structs, arrays, unions, …) | `TEXT` (JSON)      |
 *
 * Nullable (`NullOr`) and optional fields drop the `NOT NULL` constraint.
 */
export type StorageClass = "TEXT" | "INTEGER" | "DOUBLE PRECISION" | "BOOLEAN";

/** How one schema field is stored: its column name, SQL type, and flags. */
export interface ColumnSpec {
  /** The schema field name. */
  readonly field: string;
  /** The column name: `snake_case` of the field name. */
  readonly column: string;
  /** SQL type used in DDL (see {@link StorageClass}). */
  readonly sqlType: StorageClass;
  /** The column stores the JSON text of the field's encoded value. */
  readonly json: boolean;
  /** The column is created without `NOT NULL`. */
  readonly nullable: boolean;
  /** The encoded key may be absent; SQL `NULL` reads back as an absent key. */
  readonly optional: boolean;
}

/**
 * A view model: one Schema-defined row shape bound to one table. Read models
 * are denormalized, shaped per consumer, and disposable — they are rebuilt
 * from events, never migrated in place.
 */
export interface ViewModelDef<Fields extends Schema.Struct.Fields> {
  /** Logical name — used as the `NotFound` entity name. */
  readonly name: string;
  /** Table name (default: `snake_case` of `name`). */
  readonly table: string;
  /** Field holding the row identity (primary key). */
  readonly idField: string;
  /** Column name of the id field. */
  readonly idColumn: string;
  /** The row schema. */
  readonly schema: Schema.Struct<Fields>;
  /** One column per field, in field declaration order. */
  readonly columns: ReadonlyArray<ColumnSpec>;
}

/** The decoded row type of a view model definition. */
export type Of<Def extends { readonly schema: Schema.Schema.Any }> = Schema.Schema.Type<
  Def["schema"]
>;

/** The encoded (database-facing) row type of a view model definition. */
export type EncodedOf<Def extends { readonly schema: Schema.Schema.Any }> = Schema.Schema.Encoded<
  Def["schema"]
>;

const snakeCase = (name: string): string =>
  name
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();

/**
 * The single field-name → column-name mapping: `snake_case`. Applied
 * consistently for DDL and queries.
 */
export const columnName = (field: string): string => snakeCase(field);

interface Classified {
  readonly sqlType: StorageClass;
  readonly json: boolean;
  readonly nullable: boolean;
}

const TEXT: Classified = { sqlType: "TEXT", json: false, nullable: false };
const DOUBLE: Classified = { sqlType: "DOUBLE PRECISION", json: false, nullable: false };
const INTEGER: Classified = { sqlType: "INTEGER", json: false, nullable: false };
const BOOLEAN: Classified = { sqlType: "BOOLEAN", json: false, nullable: false };
const JSON_TEXT: Classified = { sqlType: "TEXT", json: true, nullable: false };

const isNullish = (ast: AST.AST): boolean =>
  AST.isUndefinedKeyword(ast) || (AST.isLiteral(ast) && ast.literal === null);

/** Walks a field's AST to pick its storage class (see {@link StorageClass}). */
const classify = (ast: AST.AST): Classified => {
  if (AST.isRefinement(ast)) {
    const schemaId = AST.getAnnotation<symbol>(ast, AST.SchemaIdAnnotationId);
    if (Option.isSome(schemaId) && schemaId.value === Schema.IntSchemaId) {
      return INTEGER;
    }
    return classify(ast.from);
  }
  // A transformation is stored in its encoded form (e.g. DateTimeUtc → ISO
  // string → TEXT); classify what actually hits the database.
  if (AST.isTransformation(ast)) {
    return classify(AST.encodedAST(ast));
  }
  if (AST.isUnion(ast)) {
    const members = ast.types.filter((member) => !isNullish(member));
    const nullable = members.length !== ast.types.length;
    const first = members[0];
    if (members.length === 1 && first !== undefined) {
      const inner = classify(first);
      return { ...inner, nullable: nullable || inner.nullable };
    }
    if (
      members.length > 1 &&
      members.every((member) => AST.isLiteral(member) && typeof member.literal === "string")
    ) {
      return { ...TEXT, nullable };
    }
    return { ...JSON_TEXT, nullable };
  }
  if (AST.isStringKeyword(ast) || AST.isTemplateLiteral(ast)) {
    return TEXT;
  }
  if (AST.isNumberKeyword(ast)) {
    return DOUBLE;
  }
  if (AST.isBooleanKeyword(ast)) {
    return BOOLEAN;
  }
  if (AST.isLiteral(ast)) {
    switch (typeof ast.literal) {
      case "string":
        return TEXT;
      case "number":
        return Number.isInteger(ast.literal) ? INTEGER : DOUBLE;
      case "boolean":
        return BOOLEAN;
      default:
        return { ...JSON_TEXT, nullable: ast.literal === null };
    }
  }
  if (AST.isEnums(ast)) {
    if (ast.enums.every(([, value]) => typeof value === "string")) {
      return TEXT;
    }
    if (ast.enums.every(([, value]) => typeof value === "number")) {
      return DOUBLE;
    }
    return JSON_TEXT;
  }
  // Structs, arrays, declarations, … — stored as JSON text of the encoded
  // value (the equivalent of a Schema.parseJson composition, applied by the
  // store's row codec).
  return JSON_TEXT;
};

/** Storage-relevant view of one field: its (encoded-side) AST + optionality. */
const fieldAst = (
  field: Schema.Struct.Field,
): { readonly ast: AST.AST; readonly optional: boolean } => {
  if (Schema.isPropertySignature(field)) {
    const ast = field.ast;
    return ast._tag === "PropertySignatureDeclaration"
      ? { ast: ast.type, optional: ast.isOptional }
      : { ast: ast.from.type, optional: ast.from.isOptional };
  }
  return { ast: field.ast, optional: false };
};

/**
 * Defines a view model: Schema fields, an id field (default `"id"`, must
 * exist in `fields`), one table (default: `snake_case` of `name`). Columns
 * are derived per field via {@link columnName} and the storage-class mapping
 * documented on {@link StorageClass}.
 *
 * Throws {@link InvalidViewModel} listing every problem when the definition
 * is malformed (missing id field, column name collisions).
 *
 * View-model fields must be context-free schemas whose encoded form is
 * JSON-serializable — this is what one database column can hold.
 */
export const define = <Fields extends Schema.Struct.Fields>(options: {
  readonly name: string;
  readonly table?: string;
  readonly idField?: keyof Fields & string;
  readonly fields: Fields;
}): ViewModelDef<Fields> => {
  const idField: string = options.idField ?? "id";
  const problems: Array<string> = [];
  const fields: Schema.Struct.Fields = options.fields;
  const fieldNames = Object.keys(fields);
  if (!fieldNames.includes(idField)) {
    problems.push(
      `id field "${idField}" is not one of the fields (${fieldNames.join(", ") || "none"})`,
    );
  }
  const seen = new Map<string, string>();
  const columns: Array<ColumnSpec> = [];
  for (const [field, schema] of Object.entries(fields)) {
    const column = columnName(field);
    const clash = seen.get(column);
    if (clash !== undefined) {
      problems.push(`fields "${clash}" and "${field}" both map to column "${column}"`);
    }
    seen.set(column, field);
    const { ast, optional } = fieldAst(schema);
    const classified = classify(ast);
    columns.push({
      field,
      column,
      sqlType: classified.sqlType,
      json: classified.json,
      nullable: classified.nullable || optional,
      optional,
    });
  }
  if (problems.length > 0) {
    throw new InvalidViewModel({ view: options.name, problems });
  }
  return {
    name: options.name,
    table: options.table ?? snakeCase(options.name),
    idField,
    idColumn: columnName(idField),
    schema: Schema.Struct(options.fields),
    columns,
  };
};

/**
 * The `CREATE TABLE IF NOT EXISTS` DDL for a view model's table: one column
 * per field, `NOT NULL` unless the field is nullable/optional, and a primary
 * key on the id column. Valid in both PostgreSQL and SQLite.
 */
export const createTableSql = <Fields extends Schema.Struct.Fields>(
  def: ViewModelDef<Fields>,
): string => {
  const columns = def.columns.map((c) => {
    const notNull = c.field === def.idField || !c.nullable ? " NOT NULL" : "";
    return `${c.column} ${c.sqlType}${notNull}`;
  });
  return `CREATE TABLE IF NOT EXISTS ${def.table} (${columns.join(", ")}, PRIMARY KEY (${def.idColumn}))`;
};

/**
 * The `@structure-ai/migrations` migration (named `create_<table>`) that
 * creates the view model's table. Add it to the application's migration set;
 * this is how view-model tables enter the schema.
 */
export const migration = <Fields extends Schema.Struct.Fields>(
  def: ViewModelDef<Fields>,
  id: number,
): Migration => {
  const sql = createTableSql(def);
  // Declaring the DDL makes the recorded checksum cover the table shape, so a
  // view model edited after its migration ran is reported as drift.
  return defineMigration(
    id,
    `create_${def.table}`,
    Effect.flatMap(SqlClient, (client) => client.unsafe(sql)).pipe(Effect.asVoid),
    { sql },
  );
};
