/**
 * `@structure-ai/jobs` — delayed and recurring jobs on PostgreSQL: named
 * schema-typed handlers, SKIP LOCKED dispatch with heartbeat leases, cron
 * scheduling with timezone support, at-least-once delivery, bounded jittered
 * retries with dead letters, graceful drain through the Shutdown
 * coordinator, per-job metrics and correlation propagation.
 */

export {
  type CronFields,
  describeCron,
  InvalidCronExpression,
  nextRun,
  parseCron,
} from "./cron.js";
export { type JobsLayerOptions, layer, workerLayer } from "./layer.js";
export { type JobsReadinessOptions, jobsReadinessCheck } from "./readiness.js";
export {
  backoffMillis,
  defineJob,
  InvalidJobPayload,
  type JobContext,
  type JobFailure,
  type JobHandler,
  type JobId,
  JobQueueError,
  type JobRef,
  jobFailure,
  makeScheduler,
  type RecurOptions,
  type ScheduleOptions,
  Scheduler,
  type SchedulerOptions,
  type SchedulerService,
  schedulerLayer,
  UnknownJob,
  type WorkerOptions,
} from "./scheduler.js";
export { type AdapterOptions, migrate, type TableNames, tableNames } from "./schema.js";
export { jobsSettings } from "./settings.js";
