import { createHash } from "node:crypto";
import type * as Migrator from "@effect/sql/Migrator";
import type { SqlClient } from "@effect/sql/SqlClient";
import { Data, Effect } from "effect";

/**
 * One forward migration. Migrations are ordered by `id` and each runs at
 * most once, recorded in the migrations table together with its `checksum`.
 * There is no `down`: per the delivery policy, irreversible changes roll
 * forward with a prepared repair (a new migration), never a rollback.
 */
export interface Migration {
  readonly id: number;
  readonly name: string;
  readonly up: Effect.Effect<void, unknown, SqlClient>;
  /**
   * sha-256 (hex) of the migration's declared identity: id, name and the
   * `sql` declared at definition time. Recorded in the bookkeeping table and
   * compared on every `status`/`run`, so an edited or renamed migration is
   * reported as `mismatched` instead of passing as applied.
   */
  readonly checksum: string;
}

export interface MigrationOptions {
  /**
   * The SQL this migration runs, as one string or one string per statement.
   * `up` is an opaque Effect and cannot be hashed; declaring the SQL here
   * makes the checksum cover the migration's content, so editing an applied
   * migration is detected as drift. Byte-exact: whitespace changes count.
   * Without it the checksum covers only id and name.
   */
  readonly sql?: string | ReadonlyArray<string>;
}

/** Raised when a migration set is malformed (duplicate or invalid ids). */
export class InvalidMigrationSet extends Data.TaggedError("InvalidMigrationSet")<{
  readonly problems: ReadonlyArray<string>;
}> {
  override get message(): string {
    return `Invalid migration set:\n${this.problems.map((p) => `  - ${p}`).join("\n")}`;
  }
}

/**
 * The checksum `defineMigration` records: sha-256 over the JSON encoding of
 * `[id, name, statements]` (no `sql` declared → `[id, name]`). Exposed so
 * tooling can compute the value an existing row should carry.
 */
export const migrationChecksum = (
  id: number,
  name: string,
  sql?: string | ReadonlyArray<string>,
): string => {
  const identity: ReadonlyArray<unknown> =
    sql === undefined ? [id, name] : [id, name, typeof sql === "string" ? [sql] : [...sql]];
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
};

export const defineMigration = (
  id: number,
  name: string,
  up: Effect.Effect<void, unknown, SqlClient>,
  options: MigrationOptions = {},
): Migration => ({ id, name, up, checksum: migrationChecksum(id, name, options.sql) });

/**
 * A validated, id-ordered collection of migrations, exposing the loader the
 * underlying `@effect/sql` Migrator consumes.
 */
export interface MigrationSet {
  readonly migrations: ReadonlyArray<Migration>;
  readonly loader: Migrator.Loader;
}

export const makeSet = (migrations: ReadonlyArray<Migration>): MigrationSet => {
  const problems: Array<string> = [];
  const seen = new Map<number, string>();
  for (const m of migrations) {
    if (!Number.isInteger(m.id) || m.id < 1) {
      problems.push(`migration "${m.name}" has invalid id ${m.id} (ids are integers >= 1)`);
    }
    const existing = seen.get(m.id);
    if (existing !== undefined) {
      problems.push(`duplicate id ${m.id}: "${existing}" and "${m.name}"`);
    }
    seen.set(m.id, m.name);
  }
  if (problems.length > 0) {
    throw new InvalidMigrationSet({ problems });
  }
  const sorted = [...migrations].sort((a, b) => a.id - b.id);
  return {
    migrations: sorted,
    // The Migrator runs `load` to obtain the migration effect, so it must
    // succeed WITH the effect, not execute it.
    loader: Effect.succeed(sorted.map((m) => [m.id, m.name, Effect.succeed(m.up)] as const)),
  };
};
