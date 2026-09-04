# @structure-ai/jobs

Delayed and recurring jobs on PostgreSQL. Jobs are named, schema-typed handlers registered at boot; the queue is a pair of tables dispatched with `SELECT … FOR UPDATE SKIP LOCKED`, heartbeat leases, at-least-once delivery, bounded jittered retries, and dead letters. Workers drain gracefully through the `@structure-ai/runtime` Shutdown coordinator, and every execution carries the scheduling site's correlation id.

## Quick start

```ts
import { defineJob, jobsReadinessCheck, layer, workerLayer, Scheduler } from "@structure-ai/jobs";
import { Effect, Layer, Schema } from "effect";

const SendDigest = defineJob(
  {
    name: "digest.send",
    payloadSchema: Schema.parseJson(Schema.Struct({ userId: Schema.String })),
  },
  (payload) => sendDigest(payload.userId),
  { maxAttempts: 5 },
);

const Jobs = layer({ url: process.env.DATABASE_URL });      // PgClient + migrate + Scheduler
const Worker = workerLayer({ role: "all" });                // drains on shutdown

// Scheduling (from commands, HTTP handlers, anywhere):
//   yield* scheduler.schedule(SendDigest, { userId }, { delay: "5 minutes" });
//   yield* scheduler.recur(SendDigest, { userId }, { cron: "0 9 * * mon-fri", timezone: "Europe/Paris" });
```

## Handlers, scheduling, cancellation

```ts
const scheduler = yield* Scheduler;

yield* scheduler.register(SendDigest);          // named handlers, idempotent per name
const id = yield* scheduler.schedule(SendDigest, { userId: "u-1" }, { delay: "1 hour" });
yield* scheduler.recur(SendDigest, { userId: "u-1" }, {
  cron: "*/5 * * * *",        // 5-field cron: lists, ranges, steps, day names
  timezone: "UTC",            // IANA names, DST-aware
  scheduleKey: "digest-u-1",  // one row per key; recur replaces it
});
yield* scheduler.cancel(id);
```

Payloads are `Schema<P, string>` (usually `Schema.parseJson(...)`) — stored as text, decoded before each execution; a payload that no longer decodes dead-letters immediately.

## Delivery semantics

- **At-least-once.** Handlers must be idempotent or dedupe (e.g. through `@structure-ai/eventsourcing`'s Inbox). A lease that expires (worker crash, GC pause) makes the run reclaimable — the job may execute twice.
- **Retries.** Handlers fail with `{ reason, classification }`: `transient` failures retry with exponential jittered backoff (1s base, 5min cap) up to `maxAttempts` (default 5); `permanent` failures dead-letter on the spot.
- **Dead letters.** Exhausted or permanently failed jobs move to `jobs_dead_letters` with their attempts, last error (bounded), and correlation id — inspectable with plain SQL.
- **Cron missed-run policy: skip.** The next occurrence is computed strictly after `max(scheduled, now)` — downtime never produces a catch-up burst.
- **`JobContext.atLeastOnce: true`** is carried into every execution as standing guidance.

## Worker lifecycle and roles

`workerLayer({ role })` follows the platform's `SERVICE_ROLE` convention: `api` processes only schedule (the layer logs and does nothing), `worker`/`all` fork the dispatch loop. The loop runs at most `concurrency` handlers at once (default `batchSize`; a semaphore enforces it) and claims only as many rows as it has free slots, waking when a slot frees rather than polling, so a backlog never turns into an unbounded fan-out. Every claim mints a `lease_owner` token, and every completion, retry, dead-letter and heartbeat is fenced on it (`WHERE id = ? AND status = 'running' AND lease_owner = ?`): a worker whose lease another worker reclaimed affects zero rows and logs `job lease lost; write skipped` instead of destroying the row the other worker is running (the fence is the token, not the expiry, so a late completion nobody reclaimed still lands). It registers a `Shutdown` finalizer: on shutdown it stops claiming, waits for in-flight handlers (bounded by the coordinator's finalizer timeout), then exits — no in-flight job is killed. `jobsSettings` (`@structure-ai/config`) maps `SERVICE_ROLE`, `JOBS_POLL_INTERVAL`, `JOBS_BATCH_SIZE`, `JOBS_CONCURRENCY`, `JOBS_LEASE`, `JOBS_TABLE_PREFIX`.

## Observability

Per-job metrics under bounded, handler-derived names: `job_<name>_calls_total` / `_errors_total` / `_duration_ms` (via `Metrics.track`), plus `jobs_dispatched_total`, `jobs_succeeded_total`, `jobs_retried_total`, `jobs_dead_lettered_total` and the `jobs_queue_depth` gauge. Structured logs per scheduling and per attempt carry job id, name, attempt, classification, bounded reason, and the correlation id captured at the scheduling site (`Correlation.within` at dispatch). `jobsReadinessCheck(scheduler, { maxDepth, maxLagMillis })` reports queue depth/lag into `/health/ready`.

## Errors

`UnknownJob`, `InvalidJobPayload` (permanent), `JobQueueError` (transient), `InvalidCronExpression` (permanent, lists every problem). All classified per the framework taxonomy.

## Schema

Two tables created by the idempotent `migrate` (own prefix, `@structure-ai/migrations`-compatible DDL): `jobs_queue` (status `queued|running`, `run_at`, `cron_expr`, `cron_timezone`, `attempt`, `max_attempts`, `lease_expires_at`, `last_error`, correlation fields) with dispatch and lease indexes, and `jobs_dead_letters`.
