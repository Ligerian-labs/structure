import type { ReadinessCheck } from "@structure-ai/runtime";
import { Effect } from "effect";
import type { Storage } from "./storage.js";

/**
 * A `Readiness` check that reports the storage driver's ability to answer
 * listings: `storage` is ready when a root `list` completes. Check failures
 * and defects count as not-ok (the runtime's `checkAll` absorbs them).
 */
export const storageReadinessCheck = (storage: Storage): ReadinessCheck => ({
  name: "storage",
  run: storage.list("").pipe(
    Effect.as(true),
    Effect.catchAllCause(() => Effect.succeed(false)),
  ),
});
