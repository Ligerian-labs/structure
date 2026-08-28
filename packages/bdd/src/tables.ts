import { Effect, type ParseResult, Schema } from "effect";

/**
 * A Gherkin data table as a normalized grid of strings, with schema-typed
 * row decoding: the first row is the header (cucumber's `hashes`
 * convention), later rows are records keyed by it.
 *
 * ```ts
 * const rowSchema = Schema.Struct({
 *   email: Schema.String,
 *   nights: Schema.NumberFromString,
 * });
 * Given("registered customers:", (world, { table }) =>
 *   Effect.forEach(table?.rows(rowSchema) ?? Effect.succeed([]), (row) =>
 *     world.dispatch(Register, row)),
 * );
 * ```
 *
 * Values stay strings unless the schema converts them — formatting
 * conventions in tables (dates, prices) are the app's to parse.
 */
export class DataTable {
  readonly #rows: ReadonlyArray<ReadonlyArray<string>>;

  constructor(rows: ReadonlyArray<ReadonlyArray<string>>) {
    this.#rows = rows;
  }

  /** The full grid, header row included, exactly as written. */
  raw(): ReadonlyArray<ReadonlyArray<string>> {
    return this.#rows;
  }

  /**
   * Rows as `Record<header, cell>` — one record per data row. The header row
   * must exist; an empty table yields `[]`.
   */
  hashes(): ReadonlyArray<Record<string, string>> {
    const [header, ...data] = this.#rows;
    if (header === undefined) return [];
    return data.map((row) => {
      const record: Record<string, string> = {};
      header.forEach((key, index) => {
        record[key] = row[index] ?? "";
      });
      return record;
    });
  }

  /**
   * Decodes each data row through a struct schema and returns the typed
   * values, failing with every issue at once when a cell does not conform —
   * so a malformed feature table points at the offending field.
   *
   * `nullLiteral` (default: none): cells exactly equal to the literal are
   * mapped to `null` before decoding, so `Schema.NullOr(...)` fields express
   * absence in tables the business edits.
   */
  rows<S extends Schema.Struct.Fields>(
    schema: Schema.Struct<S>,
    options?: { readonly nullLiteral?: string },
  ): Effect.Effect<ReadonlyArray<Schema.Schema.Type<Schema.Struct<S>>>, ParseResult.ParseError> {
    const nullLiteral = options?.nullLiteral;
    const decode = Schema.decodeUnknown(schema);
    const rows =
      nullLiteral === undefined
        ? this.hashes()
        : this.hashes().map((row) =>
            Object.fromEntries(
              Object.entries(row).map(([key, cell]) => [key, cell === nullLiteral ? null : cell]),
            ),
          );
    return Effect.forEach(rows, (row) => decode(row)) as unknown as Effect.Effect<
      ReadonlyArray<Schema.Schema.Type<Schema.Struct<S>>>,
      ParseResult.ParseError
    >;
  }
}

/** Builds a {@link DataTable} from a gherkin AST table (rows of cells). */
export const dataTableFromCells = (
  rows: ReadonlyArray<{ readonly cells: ReadonlyArray<{ readonly value: string }> }>,
): DataTable => new DataTable(rows.map((row) => row.cells.map((cell) => cell.value)));
