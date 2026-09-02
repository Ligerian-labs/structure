import * as SqlClient from "@effect/sql/SqlClient";
import { Effect } from "effect";
import type { MigrationSet } from "./migration.js";
import { inconsistencies, type StatusOptions, status } from "./run.js";

/**
 * Shape of a readiness probe as `@structure-ai/runtime`'s `Readiness.register`
 * consumes it — declared here structurally so this package stays a
 * standalone foundation with no dependency on the runtime.
 */
export interface MigrationsReadinessCheck {
  readonly name: string;
  readonly run: Effect.Effect<boolean>;
}

export interface MigrationsReadinessOptions extends StatusOptions {
  /** Probe name in the readiness report. Defaults to `"migrations"`. */
  readonly name?: string;
}

/**
 * A readiness probe for serving instances that never migrate: ready only
 * when `status(set)` has nothing `pending`, nothing `unknown` (the database
 * is not ahead of this build) and nothing `mismatched` (no migration was
 * edited after it ran). Any failure to read the bookkeeping table answers
 * "not ready"; the reason is logged at warning level with counts only.
 *
 * Resolves the `SqlClient` once, so the returned check needs no services:
 * `yield* readiness.register(yield* migrationsReadinessCheck(set))`.
 */
export const migrationsReadinessCheck = (
  set: MigrationSet,
  options: MigrationsReadinessOptions = {},
): Effect.Effect<MigrationsReadinessCheck, never, SqlClient.SqlClient> =>
  Effect.map(SqlClient.SqlClient, (sql) => ({
    name: options.name ?? "migrations",
    run: status(set, options).pipe(
      Effect.flatMap((report) =>
        report.pending.length === 0 && inconsistencies(report).length === 0
          ? Effect.succeed(true)
          : Effect.logWarning("migrations not ready").pipe(
              Effect.annotateLogs({
                pending: report.pending.length,
                unknown: report.unknown.length,
                mismatched: report.mismatched.length,
              }),
              Effect.as(false),
            ),
      ),
      Effect.catchAll((error) =>
        Effect.logWarning("migrations readiness probe failed", error).pipe(Effect.as(false)),
      ),
      Effect.provideService(SqlClient.SqlClient, sql),
    ),
  }));
