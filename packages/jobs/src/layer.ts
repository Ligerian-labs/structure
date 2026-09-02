import type * as SqlClient from "@effect/sql/SqlClient";
import type { SqlError } from "@effect/sql/SqlError";
import { PgClient } from "@effect/sql-pg";
import type { Shutdown } from "@structure-ai/runtime";
import { Effect, Layer, Redacted } from "effect";
import {
  Scheduler,
  type SchedulerOptions,
  schedulerLayer,
  type WorkerOptions,
} from "./scheduler.js";
import { migrate } from "./schema.js";

/** All-in-one layer configuration. */
export interface JobsLayerOptions extends SchedulerOptions {
  /**
   * Postgres connection URL. Defaults to `DATABASE_URL`; when neither is
   * set, the client falls back to libpq defaults.
   */
  readonly url?: string;
  readonly maxConnections?: number;
  readonly applicationName?: string;
}

/**
 * Everything in one layer: a `PgClient` (from `options.url` or
 * `DATABASE_URL`), the schema migration at build, and the `Scheduler`
 * service. The client is exposed for the app's own queries.
 */
export const layer = (
  options?: JobsLayerOptions,
): Layer.Layer<Scheduler | PgClient.PgClient | SqlClient.SqlClient, SqlError> => {
  const url = options?.url ?? process.env.DATABASE_URL;
  const client = PgClient.layer({
    ...(url !== undefined ? { url: Redacted.make(url) } : {}),
    ...(options?.maxConnections !== undefined ? { maxConnections: options.maxConnections } : {}),
    ...(options?.applicationName !== undefined ? { applicationName: options.applicationName } : {}),
  });
  const migrated = Layer.effectDiscard(migrate(options)).pipe(Layer.provideMerge(client));
  return schedulerLayer(options).pipe(Layer.provideMerge(migrated));
};

/**
 * Worker layer: role-aware boot. `api` starts nothing (the process only
 * schedules); `worker` and `all` fork the dispatch loop inside a scope and
 * register a `Shutdown` finalizer that drains it — no in-flight job is
 * killed on shutdown. Compose on top of {@link layer}.
 *
 * ```ts
 * const Jobs = layer({ url: process.env.DATABASE_URL });
 * const Worker = workerLayer({ role: process.env.SERVICE_ROLE as "api" });
 * // Layer.provide(Worker, Jobs) — or merge both into the runtime.
 * ```
 */
export const workerLayer = (
  options?: WorkerOptions,
): Layer.Layer<never, never, Scheduler | Shutdown> =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const scheduler = yield* Scheduler;
      if ((options?.role ?? "all") === "api") {
        yield* Effect.logInfo("jobs worker not started (api role)").pipe(
          Effect.annotateLogs({ jobsRole: "api" }),
        );
        return;
      }
      yield* Effect.forkScoped(scheduler.runWorker(options));
    }),
  );
