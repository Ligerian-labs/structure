import { MigrationError } from "@effect/sql/Migrator";
import { defineCommand, withSubcommands } from "@structure-ai/cli";
import { Effect } from "effect";
import type { MigrationSet } from "./migration.js";
import { inconsistencies, type RunOptions, run, status } from "./run.js";

/**
 * Ready-made `migrations` command group for a framework CLI:
 * `<app> migrations up` applies pending migrations, `<app> migrations status`
 * lists applied, pending, unknown and mismatched ones and exits non-zero when
 * the recorded history does not match the set. The host app provides the
 * SqlClient layer when running the CLI, keeping "which process may migrate"
 * an explicit deployment decision; `options.lock`/`waitFor` apply to `up`.
 */
export const migrationsCommand = (set: MigrationSet, options: RunOptions = {}) => {
  const up = defineCommand({
    name: "up",
    description: "Apply all pending migrations",
    handler: () =>
      run(set, options).pipe(
        Effect.flatMap((applied) =>
          applied.length === 0
            ? Effect.log("already up to date")
            : Effect.forEach(applied, ([id, name]) => Effect.log(`applied ${id} ${name}`)),
        ),
        Effect.asVoid,
      ),
  });

  const statusCommand = defineCommand({
    name: "status",
    description: "Show applied, pending, unknown and mismatched migrations",
    handler: () =>
      status(set, options).pipe(
        Effect.flatMap((report) =>
          Effect.gen(function* () {
            for (const m of report.applied) {
              yield* Effect.log(`applied    ${m.id} ${m.name}`);
            }
            for (const m of report.pending) {
              yield* Effect.log(`pending    ${m.id} ${m.name}`);
            }
            for (const m of report.unknown) {
              yield* Effect.log(`unknown    ${m.id} ${m.name} (not in this build's migration set)`);
            }
            for (const m of report.mismatched) {
              yield* Effect.log(`mismatched ${m.id} ${m.name} (checksum drift)`);
            }
            yield* Effect.log(
              `${report.applied.length} applied, ${report.pending.length} pending, ${report.unknown.length} unknown, ${report.mismatched.length} mismatched`,
            );
            const problems = inconsistencies(report);
            if (problems.length > 0) {
              return yield* new MigrationError({
                reason: "bad-state",
                message: `Database history does not match the migration set:\n${problems
                  .map((line) => `  - ${line}`)
                  .join("\n")}`,
              });
            }
          }),
        ),
      ),
  });

  const root = defineCommand({
    name: "migrations",
    description: "Database schema migrations",
    handler: () => Effect.log("use a subcommand: up | status"),
  });

  return withSubcommands(root, [up, statusCommand]);
};
