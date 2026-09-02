import type { ReadinessCheck } from "@structure-ai/runtime";
import { Effect } from "effect";
import type { SchedulerService } from "./scheduler.js";

export interface JobsReadinessOptions {
  /** Ready fails when the queue holds more than this many jobs. */
  readonly maxDepth?: number;
  /** Ready fails when the oldest due job has waited longer than this. */
  readonly maxLagMillis?: number;
}

/**
 * Readiness check reporting queue health: depth and lag of due work. A
 * process whose scheduler cannot keep up (or whose queue is unreachable)
 * reports not-ready so orchestrators stop routing to it. Defaults are
 * generous: 10_000 depth, 5 minutes of lag.
 */
export const jobsReadinessCheck = (
  scheduler: SchedulerService,
  options: JobsReadinessOptions = {},
): ReadinessCheck => ({
  name: "jobs",
  run: Effect.gen(function* () {
    const depth = yield* scheduler.depth.pipe(Effect.orElseSucceed(() => Number.POSITIVE_INFINITY));
    const lag = yield* scheduler.lagMillis.pipe(
      Effect.orElseSucceed(() => Number.POSITIVE_INFINITY),
    );
    return depth <= (options.maxDepth ?? 10_000) && lag <= (options.maxLagMillis ?? 5 * 60_000);
  }),
});
