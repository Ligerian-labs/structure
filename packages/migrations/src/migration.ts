import type * as Migrator from "@effect/sql/Migrator";
import type { SqlClient } from "@effect/sql/SqlClient";
import { Data, Effect } from "effect";

/**
 * One forward migration. Migrations are ordered by `id` and each runs at
 * most once, recorded in the migrations table. There is no `down`: per the
 * delivery policy, irreversible changes roll forward with a prepared repair
 * (a new migration), never a rollback.
 */
export interface Migration {
  readonly id: number;
  readonly name: string;
  readonly up: Effect.Effect<void, unknown, SqlClient>;
}

/** Raised when a migration set is malformed (duplicate or invalid ids). */
export class InvalidMigrationSet extends Data.TaggedError("InvalidMigrationSet")<{
  readonly problems: ReadonlyArray<string>;
}> {
  override get message(): string {
    return `Invalid migration set:\n${this.problems.map((p) => `  - ${p}`).join("\n")}`;
  }
}

export const defineMigration = (
  id: number,
  name: string,
  up: Effect.Effect<void, unknown, SqlClient>,
): Migration => ({ id, name, up });

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
