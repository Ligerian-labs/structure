import type * as SqlClient from "@effect/sql/SqlClient";
import type { SqlError } from "@effect/sql/SqlError";
import { PgClient } from "@effect/sql-pg";
import { Readiness, type Shutdown } from "@structure-ai/runtime";
import { Cause, Duration, Effect, Exit, Layer, Option, Redacted, Ref } from "effect";
import {
  backoffMillis,
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
 * Restart policy for the supervised worker loop: exponential backoff with
 * ±50% jitter over `baseMillis`, capped at `capMillis`, drawn from `random`
 * (injectable for deterministic tests). The backoff lengthens with each
 * consecutive failed run; a run only exits by failing, draining cleanly or
 * being interrupted, and the latter two end supervision rather than restart.
 */
export interface WorkerRestartOptions {
  /** Backoff base. Default 1_000 millis. */
  readonly baseMillis?: number;
  /** Backoff ceiling. Default 5 minutes. */
  readonly capMillis?: number;
  /** Jitter source. Default `Math.random`. */
  readonly random?: () => number;
}

/**
 * `workerLayer` options: the worker's own options plus its restart policy.
 * `restart` defaults to enabled with the base policy: a worker that fails
 * (a transient claim, completion or heartbeat error, a defect) is restarted
 * with bounded jittered backoff, and the `jobs-worker` readiness check is
 * false only while the worker is actually down. `false` restores the
 * one-shot behavior where the first failure stops the worker for good.
 */
export interface WorkerLayerOptions extends WorkerOptions {
  readonly restart?: boolean | WorkerRestartOptions;
}

const baseRestart: WorkerRestartOptions = { baseMillis: 1_000, capMillis: 5 * 60_000 };

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
 * killed on shutdown. The loop is supervised: a failed run (transient queue
 * error, defect, compound handler cause) is restarted with bounded jittered
 * backoff, so a single failed claim no longer stops the worker until
 * process restart; the `jobs-worker` readiness check reports not ready only
 * while the worker is down. A run that exits cleanly (the shutdown drain)
 * or is interrupted (scope close) ends supervision. Compose on top of
 * {@link layer}.
 *
 * ```ts
 * const Jobs = layer({ url: process.env.DATABASE_URL });
 * const Worker = workerLayer({ role: process.env.SERVICE_ROLE as "api" });
 * // Layer.provide(Worker, Jobs) — or merge both into the runtime.
 * ```
 */
export const workerLayer = (
  options?: WorkerLayerOptions,
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
      const readiness = yield* Effect.serviceOption(Readiness);
      const running = yield* Ref.make(true);
      if (Option.isSome(readiness)) {
        yield* readiness.value.register({ name: "jobs-worker", run: Ref.get(running) });
      }

      const restart: boolean | WorkerRestartOptions = options?.restart ?? true;
      if (restart === false) {
        yield* Effect.forkScoped(
          scheduler.runWorker(options).pipe(
            Effect.tapErrorCause((cause) =>
              Cause.isInterruptedOnly(cause)
                ? Effect.void
                : Effect.logError("jobs worker stopped after failure", cause),
            ),
            Effect.ensuring(Ref.set(running, false)),
          ),
        );
        return;
      }

      const policy: WorkerRestartOptions =
        restart === true ? baseRestart : { ...baseRestart, ...restart };
      const random = policy.random ?? Math.random;

      let stopped = false;
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          let failures = 0;
          yield* Effect.whileLoop({
            while: () => !stopped,
            body: () =>
              Effect.gen(function* () {
                yield* Ref.set(running, true);
                const exit = yield* scheduler.runWorker(options).pipe(Effect.exit);
                yield* Ref.set(running, false);
                if (Exit.isSuccess(exit)) {
                  // A clean exit is the shutdown drain completing: the
                  // coordinator owns what happens next, never a restart.
                  stopped = true;
                  return;
                }
                if (Cause.isInterruptedOnly(exit.cause)) {
                  stopped = true;
                  return;
                }
                failures += 1;
                const backoff = backoffMillis(
                  failures,
                  random,
                  policy.baseMillis,
                  policy.capMillis,
                );
                yield* Effect.logError(
                  "jobs worker failed; restarting with backoff",
                  exit.cause,
                ).pipe(
                  Effect.annotateLogs({
                    jobsRestartAttempt: failures,
                    jobsRestartBackoffMillis: backoff,
                  }),
                );
                // Interruptible on purpose: a scope close during the backoff
                // must stop supervision at once.
                yield* Effect.sleep(Duration.millis(backoff));
              }),
            step: () => undefined,
          });
        }).pipe(Effect.ensuring(Ref.set(running, false))),
      );
    }),
  );
