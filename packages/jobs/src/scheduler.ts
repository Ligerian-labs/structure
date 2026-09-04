import * as SqlClient from "@effect/sql/SqlClient";
import type * as Statement from "@effect/sql/Statement";
import { Correlation, Metrics } from "@structure-ai/observability";
import { Shutdown } from "@structure-ai/runtime";
import {
  Context,
  Data,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Layer,
  Metric,
  Option,
  Schema as S,
  Schedule,
} from "effect";
import { InvalidCronExpression, nextRun, parseCron } from "./cron.js";
import { type AdapterOptions, tableNames } from "./schema.js";

// --- errors ---------------------------------------------------------------------

/** The job reference is not registered in this process. */
export class UnknownJob extends Data.TaggedError("UnknownJob")<{
  readonly jobName: string;
}> {
  readonly classification: "permanent" = "permanent";
  override get message(): string {
    return `job "${this.jobName}" is not registered`;
  }
}

/** The payload failed schema decoding. */
export class InvalidJobPayload extends Data.TaggedError("InvalidJobPayload")<{
  readonly jobName: string;
  readonly reason: string;
}> {
  readonly classification: "permanent" = "permanent";
  override get message(): string {
    return `payload for job "${this.jobName}" is invalid`;
  }
}

/** Scheduling failed against the queue. Transient. */
export class JobQueueError extends Data.TaggedError("JobQueueError")<{
  readonly operation: string;
  readonly cause?: unknown;
}> {
  readonly classification: "transient" = "transient";
  override get message(): string {
    return `job queue failed during ${this.operation}`;
  }
}

/** Storage shape a handler returns to steer retry behavior. */
export interface JobFailure {
  readonly reason: string;
  readonly classification: "transient" | "permanent";
}

// --- definitions ------------------------------------------------------------------

/** Minimal reference for scheduling: a name plus its payload codec schema. */
export interface JobRef<P> {
  readonly name: string;
  /** Schema between the payload type and its stored JSON text. */
  readonly payloadSchema: S.Schema<P, string>;
}

export interface JobContext {
  readonly jobId: string;
  readonly attempt: number;
  readonly scheduledFor: Date;
  /** Delivery is at-least-once: handlers must be idempotent or dedupe. */
  readonly atLeastOnce: true;
}

/** A named handler registered at boot; the scheduler dispatches into it. */
export interface JobHandler<P> extends JobRef<P> {
  readonly handle: (payload: P, context: JobContext) => Effect.Effect<void, JobFailure>;
  /** Overrides the default of 5 attempts (transient failures only). */
  readonly maxAttempts?: number;
}

/** Type-erased handler as the scheduler stores it internally. */
export interface StoredJobHandler {
  readonly name: string;
  readonly payloadSchema: S.Schema<unknown, string>;
  readonly handle: (payload: unknown, context: JobContext) => Effect.Effect<void, JobFailure>;
  readonly maxAttempts?: number;
}

export const defineJob = <P>(
  ref: JobRef<P>,
  handle: JobHandler<P>["handle"],
  options?: { readonly maxAttempts?: number },
): JobHandler<P> => ({
  ...ref,
  handle,
  ...(options?.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
});

// --- scheduler service --------------------------------------------------------------

export type JobId = string;

export interface ScheduleOptions {
  /** Delay before the job becomes due. Default: immediately. */
  readonly delay?: Duration.DurationInput;
  /** Overrides the scheduling site's correlation id. */
  readonly correlationId?: string;
}

export interface RecurOptions {
  /** 5-field cron expression, evaluated in `timezone` (default UTC). */
  readonly cron: string;
  readonly timezone?: string;
  /**
   * Stable id for the recurring row: one row per key, `recur` replaces it.
   * Defaults to a fresh uuid (a second call schedules a second row).
   */
  readonly scheduleKey?: string;
  readonly correlationId?: string;
}

export interface WorkerOptions {
  /** Idle poll interval. Default 1s. */
  readonly pollInterval?: Duration.DurationInput;
  /** Rows claimed per poll, never more than the free concurrency. Default 10. */
  readonly batchSize?: number;
  /**
   * Ceiling on handlers executing at once in this worker, enforced by a
   * semaphore; the claim loop never takes more rows than it has free slots
   * and waits for a slot instead of polling when full. Default `batchSize`.
   */
  readonly concurrency?: number;
  /** Lease held while a handler runs; expiry makes the row reclaimable. Default 60s. */
  readonly lease?: Duration.DurationInput;
  /**
   * How long the shutdown drain waits for in-flight handlers before giving
   * up. Keep it below the coordinator's finalizer timeout so the worker,
   * not the coordinator, decides. On overrun (or when the coordinator cuts
   * the drain first) every job still in flight is returned to the queue:
   * lease released, claimable at once, logged by id at error level; its
   * late completion is fenced out. Default: wait until the coordinator cuts.
   */
  readonly drainTimeout?: Duration.DurationInput;
  /**
   * Role-aware boot: `api` runs no worker (scheduling only), `worker` and
   * `all` do. Default `all`.
   */
  readonly role?: "api" | "worker" | "all";
}

interface QueueRow {
  readonly id: string;
  readonly job_name: string;
  readonly payload: string;
  readonly attempt: number;
  readonly max_attempts: number;
  readonly cron_expr: string | null;
  readonly cron_timezone: string | null;
  readonly correlation_id: string | null;
  readonly run_at: Date | string;
  /** The token minted by the claim that produced this row; the fence for every write to it. */
  readonly lease_owner: string;
}

export interface SchedulerService {
  /** Registers a named handler. Idempotent per name (last registration wins). */
  readonly register: <P>(handler: JobHandler<P>) => Effect.Effect<void>;
  readonly schedule: <P>(
    job: JobRef<P>,
    payload: P,
    options?: ScheduleOptions,
  ) => Effect.Effect<JobId, InvalidJobPayload | JobQueueError>;
  readonly recur: <P>(
    job: JobRef<P>,
    payload: P,
    options: RecurOptions,
  ) => Effect.Effect<JobId, InvalidCronExpression | InvalidJobPayload | JobQueueError>;
  readonly cancel: (jobId: JobId) => Effect.Effect<void, JobQueueError>;
  /** Queue depth: rows not yet completed (queued + running). */
  readonly depth: Effect.Effect<number, JobQueueError>;
  /** Lag: milliseconds since the oldest due-but-incomplete run. */
  readonly lagMillis: Effect.Effect<number, JobQueueError>;
  /** Names of registered handlers, for boot-time wiring checks. */
  readonly registeredJobs: () => ReadonlyArray<string>;
  /**
   * Runs the worker loop until the Shutdown coordinator triggers, then
   * drains: no in-flight job is interrupted, and a drain that outlives its
   * budget returns the in-flight jobs to the queue. Claims with
   * `FOR UPDATE SKIP LOCKED`, heartbeats its lease, retries transient
   * failures with jittered backoff, and dead-letters permanent failures and
   * exhausted attempts.
   */
  readonly runWorker: (options?: WorkerOptions) => Effect.Effect<void, never, Shutdown>;
}

export class Scheduler extends Context.Tag("@structure-ai/jobs/Scheduler")<
  Scheduler,
  SchedulerService
>() {}

export interface SchedulerOptions extends AdapterOptions {
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
  readonly random?: () => number;
}

const runAtOf = (row: QueueRow): Date =>
  row.run_at instanceof Date ? row.run_at : new Date(row.run_at);

/** Backoff for attempt N (1-based): exponential, capped, ±50% jitter. */
export const backoffMillis = (
  attempt: number,
  random: () => number,
  baseMillis = 1_000,
  capMillis = 5 * 60_000,
): number => {
  const exponential = Math.min(baseMillis * 2 ** (attempt - 1), capMillis);
  return Math.round(exponential * (0.5 + random()));
};

export const makeScheduler = (
  options: SchedulerOptions = {},
): Effect.Effect<SchedulerService, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const tables = tableNames(options);
    const now = options.now ?? (() => new Date());
    const random = options.random ?? Math.random;
    const handlers = new Map<string, StoredJobHandler>();

    const dispatched = Metric.counter("jobs_dispatched_total", { incremental: true });
    const succeeded = Metric.counter("jobs_succeeded_total", { incremental: true });
    const retried = Metric.counter("jobs_retried_total", { incremental: true });
    const deadLettered = Metric.counter("jobs_dead_lettered_total", { incremental: true });
    const boundaries = new Map<string, Metrics.BoundaryMetrics>();
    const boundaryFor = (jobName: string): Metrics.BoundaryMetrics => {
      const existing = boundaries.get(jobName);
      if (existing !== undefined) return existing;
      const created = Metrics.boundary(`job_${jobName}`);
      boundaries.set(jobName, created);
      return created;
    };

    const queueError = (operation: string, cause: unknown): JobQueueError =>
      new JobQueueError({ operation, cause });

    const encodePayload = <P>(schema: S.Schema<P, string>, payload: P) =>
      S.encodeUnknown(schema)(payload);

    const maxAttemptsFor = (jobName: string): number => handlers.get(jobName)?.maxAttempts ?? 5;

    /**
     * Runs a terminal write scoped to the row AND the lease this worker
     * holds on it. A worker whose lease was reclaimed by another affects
     * zero rows and logs that it lost the lease instead of destroying the
     * row the other worker is running. The fence is the owner token, not
     * the lease expiry: a late completion whose lease expired but was not
     * reclaimed still lands, which is a job done once rather than twice.
     */
    const fenced = (
      row: QueueRow,
      operation: string,
      statement: Statement.Fragment,
    ): Effect.Effect<boolean, unknown> =>
      Effect.gen(function* () {
        const affected = yield* sql<{ readonly id: string }>`
          ${statement}
          WHERE id = ${row.id} AND status = 'running' AND lease_owner = ${row.lease_owner}
          RETURNING id
        `;
        if (affected.length > 0) return true;
        yield* Effect.logWarning("job lease lost; write skipped").pipe(
          Effect.annotateLogs({
            jobId: row.id,
            jobName: row.job_name,
            jobAttempt: row.attempt,
            jobOperation: operation,
          }),
        );
        return false;
      });

    const deadLetter = (row: QueueRow, reason: string): Effect.Effect<void, JobQueueError> =>
      Effect.gen(function* () {
        // The fence comes first, in one transaction with the dead-letter
        // insert: a worker that lost its lease must not file a dead letter
        // for a job another worker is running, and a job whose queue row is
        // gone must always have its dead letter.
        const owned = yield* sql.withTransaction(
          Effect.gen(function* () {
            const owned = yield* fenced(row, "dead-letter", sql`DELETE FROM ${sql(tables.queue)}`);
            if (!owned) return false;
            yield* sql`
              INSERT INTO ${sql(tables.deadLetters)}
                (id, job_name, payload, attempts, last_error, correlation_id, dead_at)
              VALUES
                (${crypto.randomUUID()}, ${row.job_name}, ${row.payload}, ${row.attempt},
                 ${reason.slice(0, 2_048)}, ${row.correlation_id}, ${now().toISOString()})
            `;
            return true;
          }),
        );
        if (!owned) return;
        yield* Metric.increment(deadLettered);
        yield* Effect.logError("job dead-lettered").pipe(
          Effect.annotateLogs({
            jobId: row.id,
            jobName: row.job_name,
            jobAttempts: row.attempt,
            jobReason: reason.slice(0, 256),
          }),
        );
      }).pipe(Effect.mapError((cause) => queueError("dead-letter", cause)));

    const completeSuccess = (row: QueueRow): Effect.Effect<void, JobQueueError> =>
      Effect.gen(function* () {
        if (row.cron_expr === null) {
          yield* fenced(row, "complete-success", sql`DELETE FROM ${sql(tables.queue)}`);
          return;
        }
        const fields = yield* parseCron(row.cron_expr);
        const timezone = row.cron_timezone ?? "UTC";
        // Missed-run policy: skip. The next fire is strictly after
        // max(scheduled time, now) — downtime never produces a catch-up burst.
        const next = nextRun(
          new Date(Math.max(runAtOf(row).getTime(), now().getTime())),
          fields,
          timezone,
        );
        if (next === undefined) {
          yield* fenced(row, "complete-success", sql`DELETE FROM ${sql(tables.queue)}`);
          return;
        }
        yield* fenced(
          row,
          "complete-success",
          sql`
            UPDATE ${sql(tables.queue)}
            SET status = 'queued', run_at = ${next.toISOString()}, attempt = 0,
                lease_expires_at = NULL, lease_owner = NULL, updated_at = ${now().toISOString()}
          `,
        );
      }).pipe(Effect.mapError((cause) => queueError("complete-success", cause)));

    const rescheduleRetry = (row: QueueRow, reason: string): Effect.Effect<void, JobQueueError> =>
      Effect.gen(function* () {
        const backoff = backoffMillis(row.attempt, random);
        const owned = yield* fenced(
          row,
          "reschedule-retry",
          sql`
            UPDATE ${sql(tables.queue)}
            SET status = 'queued', run_at = ${new Date(now().getTime() + backoff).toISOString()},
                lease_expires_at = NULL, lease_owner = NULL, last_error = ${reason.slice(0, 2_048)},
                updated_at = ${now().toISOString()}
          `,
        );
        if (!owned) return;
        yield* Metric.increment(retried);
        yield* Effect.logWarning("job attempt failed, retrying with backoff").pipe(
          Effect.annotateLogs({
            jobId: row.id,
            jobName: row.job_name,
            jobAttempt: row.attempt,
            jobBackoffMillis: backoff,
            jobReason: reason.slice(0, 256),
          }),
        );
      }).pipe(Effect.mapError((cause) => queueError("reschedule-retry", cause)));

    const claim = (
      batchSize: number,
      leaseMillis: number,
    ): Effect.Effect<ReadonlyArray<QueueRow>, JobQueueError> => {
      const timestamp = now();
      const leaseUntil = new Date(timestamp.getTime() + leaseMillis);
      const owner = crypto.randomUUID();
      return sql<QueueRow>`
        WITH picked AS (
          SELECT id FROM ${sql(tables.queue)}
          WHERE (status = 'queued' AND run_at <= ${timestamp.toISOString()})
             OR (status = 'running' AND lease_expires_at <= ${timestamp.toISOString()})
          ORDER BY run_at
          LIMIT ${batchSize}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE ${sql(tables.queue)} queue
        SET status = 'running', attempt = queue.attempt + 1,
            lease_expires_at = ${leaseUntil.toISOString()},
            lease_owner = ${owner},
            updated_at = ${timestamp.toISOString()}
        FROM picked
        WHERE queue.id = picked.id
        RETURNING queue.id, queue.job_name, queue.payload, queue.attempt,
                  queue.max_attempts, queue.cron_expr, queue.cron_timezone,
                  queue.correlation_id, queue.run_at, queue.lease_owner
      `.pipe(
        Effect.mapError((cause) => queueError("claim", cause)),
        Effect.tap((rows) =>
          rows.length === 0 ? Effect.void : Metric.incrementBy(dispatched, rows.length),
        ),
      );
    };

    const execute = (row: QueueRow, leaseMillis: number): Effect.Effect<void> => {
      const handler: StoredJobHandler | undefined = handlers.get(row.job_name);
      const context: JobContext = {
        jobId: row.id,
        attempt: row.attempt,
        scheduledFor: runAtOf(row),
        atLeastOnce: true,
      };
      const correlation = Correlation.within({
        ...(row.correlation_id === null ? {} : { correlationId: row.correlation_id }),
        causationId: row.id,
      });

      const heartbeat: Effect.Effect<void> = Effect.gen(function* () {
        const until = new Date(now().getTime() + leaseMillis);
        // Fenced like every other write: an evicted worker must not keep
        // extending the lease another worker now owns.
        yield* sql`
          UPDATE ${sql(tables.queue)}
          SET lease_expires_at = ${until.toISOString()}
          WHERE id = ${row.id} AND status = 'running' AND lease_owner = ${row.lease_owner}
        `.pipe(Effect.asVoid);
      }).pipe(
        Effect.asVoid,
        Effect.repeat(Schedule.spaced(`${Math.max(1, Math.floor(leaseMillis / 3))} millis`)),
        Effect.asVoid,
        Effect.catchAllCause(() => Effect.void),
      );

      const runOutcome: Effect.Effect<void> = Effect.gen(function* () {
        if (handler === undefined) {
          yield* Effect.logError("job dispatched with no registered handler").pipe(
            Effect.annotateLogs({ jobId: row.id, jobName: row.job_name }),
          );
          yield* deadLetter(row, "unknown-job").pipe(Effect.orDie);
          return;
        }
        const decoded = yield* S.decodeUnknown(handler.payloadSchema)(row.payload).pipe(
          Effect.either,
        );
        if (decoded._tag === "Left") {
          yield* deadLetter(row, `invalid-payload: ${String(decoded.left).slice(0, 128)}`).pipe(
            Effect.orDie,
          );
          return;
        }
        const failure = yield* handler
          .handle(decoded.right, context)
          .pipe(Metrics.track(`job_${row.job_name}`, boundaryFor(row.job_name)), Effect.either);
        if (failure._tag === "Right") {
          yield* Metric.increment(succeeded);
          yield* completeSuccess(row).pipe(Effect.orDie);
          return;
        }
        const error = failure.left;
        yield* Effect.logWarning("job attempt failed").pipe(
          Effect.annotateLogs({
            jobId: row.id,
            jobName: row.job_name,
            jobAttempt: row.attempt,
            jobClassification: error.classification,
            jobReason: error.reason.slice(0, 256),
          }),
        );
        const exhausted = row.attempt >= (row.max_attempts || maxAttemptsFor(row.job_name));
        if (error.classification === "permanent" || exhausted) {
          yield* deadLetter(row, error.reason).pipe(Effect.orDie);
          return;
        }
        yield* rescheduleRetry(row, error.reason).pipe(Effect.orDie);
      });

      return Effect.gen(function* () {
        const heartbeatFiber = yield* Effect.fork(
          heartbeat.pipe(Effect.catchAllCause(() => Effect.void)),
        );
        yield* runOutcome.pipe(
          Effect.ensuring(
            Fiber.interrupt(heartbeatFiber).pipe(
              Effect.catchAllCause(() => Effect.void),
              Effect.asVoid,
            ),
          ),
          correlation,
        );
      });
    };

    const runWorker = (workerOptions: WorkerOptions = {}): Effect.Effect<void, never, Shutdown> =>
      Effect.gen(function* () {
        const shutdown = yield* Shutdown;
        const pollMillis =
          workerOptions.pollInterval === undefined
            ? 1_000
            : Duration.toMillis(Duration.decode(workerOptions.pollInterval));
        const batchSize = Math.max(1, workerOptions.batchSize ?? 10);
        const concurrency = Math.max(1, workerOptions.concurrency ?? batchSize);
        const leaseMillis =
          workerOptions.lease === undefined
            ? 60_000
            : Duration.toMillis(Duration.decode(workerOptions.lease));

        const drainTimeout =
          workerOptions.drainTimeout === undefined
            ? undefined
            : Duration.decode(workerOptions.drainTimeout);

        const inflight = new Map<Fiber.RuntimeFiber<void, unknown>, QueueRow>();
        // The bound itself: a handler runs only while holding one permit, so
        // even a miscounted claim can never exceed `concurrency` executions.
        const permits = yield* Effect.makeSemaphore(concurrency);
        // Signalled whenever an in-flight fiber ends, so a full worker wakes
        // as soon as a slot frees instead of sleeping a whole poll interval.
        let slotFreed = yield* Deferred.make<void>();
        let stopRequested = false;

        const awaitInflight: Effect.Effect<void> = Effect.whileLoop({
          while: () => inflight.size > 0,
          body: () => Effect.sleep("10 millis"),
          step: () => undefined,
        });

        // The drain gave up (its own budget, or the coordinator's cut): return
        // every in-flight job to the queue so another worker picks it up at
        // once instead of after a full lease, and say which ones, loudly.
        // The handlers keep running until the process ends; their writes are
        // fenced out by the released lease.
        const abandonDrain: Effect.Effect<void> = Effect.gen(function* () {
          const rows = [...inflight.values()];
          if (rows.length === 0) return;
          yield* Effect.logError("jobs worker abandoned drain").pipe(
            Effect.annotateLogs({
              jobIds: rows.map((row) => row.id).join(","),
              jobCount: rows.length,
            }),
          );
          const timestamp = now().toISOString();
          yield* Effect.forEach(
            rows,
            (row) =>
              sql`
                UPDATE ${sql(tables.queue)}
                SET status = 'queued', run_at = ${timestamp}, lease_expires_at = NULL,
                    lease_owner = NULL, updated_at = ${timestamp}
                WHERE id = ${row.id} AND status = 'running' AND lease_owner = ${row.lease_owner}
              `.pipe(Effect.asVoid),
            { discard: true },
          );
        }).pipe(Effect.catchAllCause(() => Effect.void));

        yield* shutdown.onShutdown(
          "jobs-worker",
          Effect.sync(() => {
            stopRequested = true;
          }).pipe(
            Effect.zipRight(Effect.logInfo("jobs worker draining")),
            Effect.zipRight(
              drainTimeout === undefined
                ? awaitInflight
                : awaitInflight.pipe(
                    Effect.timeoutOption(drainTimeout),
                    Effect.flatMap((completed) =>
                      Option.isNone(completed) ? abandonDrain : Effect.void,
                    ),
                  ),
            ),
            Effect.onInterrupt(() => abandonDrain),
          ),
        );

        const loop: Effect.Effect<void> = Effect.whileLoop({
          while: () => !stopRequested,
          body: () =>
            Effect.gen(function* () {
              const shuttingDown = yield* shutdown.isShuttingDown;
              if (shuttingDown) stopRequested = true;
              if (stopRequested) return;
              // Claim at most as many rows as there are free slots: a claimed
              // row that could not start would sit on a ticking lease.
              const waiter = slotFreed;
              const capacity = Math.min(batchSize, concurrency - inflight.size);
              if (capacity <= 0) {
                yield* Deferred.await(waiter).pipe(Effect.timeout(pollMillis), Effect.ignore);
                return;
              }
              const rows = yield* Effect.orDie(claim(capacity, leaseMillis));
              if (rows.length === 0) {
                yield* Effect.sleep(pollMillis);
                return;
              }
              for (const row of rows) {
                const fiber = yield* Effect.fork(permits.withPermits(1)(execute(row, leaseMillis)));
                inflight.set(fiber, row);
                void fiber.addObserver(() => {
                  inflight.delete(fiber);
                  Deferred.unsafeDone(slotFreed, Effect.void);
                });
              }
              if (inflight.size >= concurrency) {
                slotFreed = yield* Deferred.make<void>();
              }
            }),
          step: () => undefined,
        });
        yield* loop;
        // Graceful drain: wait for in-flight handlers to finish.
        yield* awaitInflight;
        yield* Effect.logInfo("jobs worker drained").pipe(
          Effect.annotateLogs({ drained: inflight.size }),
        );
      });

    const service: SchedulerService = {
      register: <P>(handler: JobHandler<P>) =>
        Effect.sync(() => {
          handlers.set(handler.name, handler as unknown as StoredJobHandler);
        }),
      schedule: (job, payload, scheduleOptions) =>
        Effect.gen(function* () {
          const encoded = yield* encodePayload(job.payloadSchema, payload).pipe(
            Effect.mapError(
              (cause): InvalidJobPayload =>
                new InvalidJobPayload({ jobName: job.name, reason: String(cause) }),
            ),
          );
          const jobId = crypto.randomUUID();
          const correlation =
            scheduleOptions?.correlationId ??
            (yield* Effect.map(Correlation.current, (context) => context.correlationId ?? null));
          const fireAt =
            scheduleOptions?.delay === undefined
              ? now()
              : new Date(
                  now().getTime() + Duration.toMillis(Duration.decode(scheduleOptions.delay)),
                );
          yield* sql`
            INSERT INTO ${sql(tables.queue)}
              (id, job_name, payload, status, run_at, attempt, max_attempts,
               correlation_id, created_at, updated_at)
            VALUES
              (${jobId}, ${job.name}, ${encoded}, 'queued', ${fireAt.toISOString()}, 0,
               ${maxAttemptsFor(job.name)}, ${correlation},
               ${now().toISOString()}, ${now().toISOString()})
          `.pipe(Effect.mapError((cause) => queueError("schedule", cause)));
          yield* Effect.logInfo("job scheduled").pipe(
            Effect.annotateLogs({ jobId, jobName: job.name, jobRunAt: fireAt.toISOString() }),
          );
          return jobId;
        }),
      recur: (job, payload, recurOptions) =>
        Effect.gen(function* () {
          const fields = yield* parseCron(recurOptions.cron);
          const encoded = yield* encodePayload(job.payloadSchema, payload).pipe(
            Effect.mapError(
              (cause): InvalidJobPayload =>
                new InvalidJobPayload({ jobName: job.name, reason: String(cause) }),
            ),
          );
          const first = nextRun(now(), fields, recurOptions.timezone ?? "UTC");
          if (first === undefined) {
            return yield* new InvalidCronExpression({
              expression: recurOptions.cron,
              problems: ["never fires"],
            });
          }
          const jobId = recurOptions.scheduleKey ?? crypto.randomUUID();
          const correlation =
            recurOptions.correlationId ??
            (yield* Effect.map(Correlation.current, (context) => context.correlationId ?? null));
          yield* sql`
            INSERT INTO ${sql(tables.queue)}
              (id, job_name, payload, status, run_at, cron_expr, cron_timezone, attempt,
               max_attempts, correlation_id, created_at, updated_at)
            VALUES
              (${jobId}, ${job.name}, ${encoded}, 'queued', ${first.toISOString()},
               ${recurOptions.cron}, ${recurOptions.timezone ?? "UTC"}, 0,
               ${maxAttemptsFor(job.name)}, ${correlation},
               ${now().toISOString()}, ${now().toISOString()})
            ON CONFLICT (id) DO UPDATE SET
              payload = excluded.payload,
              run_at = excluded.run_at,
              cron_expr = excluded.cron_expr,
              cron_timezone = excluded.cron_timezone,
              status = 'queued',
              attempt = 0,
              lease_expires_at = NULL,
              correlation_id = excluded.correlation_id,
              updated_at = excluded.updated_at
          `.pipe(Effect.mapError((cause) => queueError("recur", cause)));
          yield* Effect.logInfo("recurring job scheduled").pipe(
            Effect.annotateLogs({
              jobId,
              jobName: job.name,
              jobCron: recurOptions.cron,
              jobNextRun: first.toISOString(),
            }),
          );
          return jobId;
        }),
      cancel: (jobId) =>
        Effect.asVoid(
          sql`DELETE FROM ${sql(tables.queue)} WHERE id = ${jobId}`.pipe(
            Effect.mapError((cause) => queueError("cancel", cause)),
          ),
        ),
      depth: Effect.map(
        sql<{ readonly count: string }>`
          SELECT COUNT(*)::text AS count FROM ${sql(tables.queue)}
        `.pipe(Effect.mapError((cause) => queueError("depth", cause))),
        (rows) => Number(rows[0]?.count ?? "0"),
      ),
      lagMillis: Effect.map(
        sql<{ readonly lag: string | null }>`
          SELECT (EXTRACT(EPOCH FROM (${now().toISOString()}::timestamptz - MIN(run_at))) * 1000)::text AS lag
          FROM ${sql(tables.queue)}
          WHERE status = 'queued' AND run_at <= ${now().toISOString()}
        `.pipe(Effect.mapError((cause) => queueError("lag", cause))),
        (rows) => {
          const lag = rows[0]?.lag;
          return lag === null || lag === undefined ? 0 : Math.max(0, Number(lag));
        },
      ),
      registeredJobs: () => [...handlers.keys()],
      runWorker,
    };
    return service;
  });

/** `Scheduler` layer over an existing `SqlClient` (schema must exist). */
export const schedulerLayer = (
  options?: SchedulerOptions,
): Layer.Layer<Scheduler, never, SqlClient.SqlClient> =>
  Layer.effect(Scheduler, makeScheduler(options));

/** Decoded failure helper for tests and app-level handlers. */
export const jobFailure = (
  reason: string,
  classification: JobFailure["classification"] = "transient",
): JobFailure => ({
  reason,
  classification,
});
