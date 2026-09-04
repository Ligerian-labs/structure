import { Settings } from "@structure-ai/config";
import { Duration } from "effect";

/**
 * Standard jobs settings. `SERVICE_ROLE` follows the platform convention:
 * `api` processes schedule but never run jobs, `worker` processes only run
 * them, `all` does both.
 */
export const jobsSettings = Settings.struct({
  role: Settings.literal("SERVICE_ROLE", ["api", "worker", "all"], {
    description: "process role: api schedules only, worker/all also dispatch jobs",
    default: "all",
  }),
  pollInterval: Settings.duration("JOBS_POLL_INTERVAL", {
    description: "worker idle poll interval",
    default: Duration.seconds(1),
  }),
  batchSize: Settings.int("JOBS_BATCH_SIZE", {
    description: "jobs claimed per poll (never more than the free concurrency)",
    default: 10,
  }),
  concurrency: Settings.optional(
    Settings.int("JOBS_CONCURRENCY", {
      description: "ceiling on jobs executing at once per worker (default: JOBS_BATCH_SIZE)",
    }),
  ),
  lease: Settings.duration("JOBS_LEASE", {
    description: "dispatch lease duration before a running job becomes reclaimable",
    default: Duration.seconds(60),
  }),
  tablePrefix: Settings.string("JOBS_TABLE_PREFIX", {
    description: "jobs table name prefix",
    default: "jobs_",
  }),
});
