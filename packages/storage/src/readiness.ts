import type { ReadinessCheck } from "@structure-ai/runtime";
import { Effect } from "effect";
import type { ObjectKey } from "./key.js";
import type { Storage } from "./storage.js";

/** The one key a readiness probe asks about; it is never expected to exist. */
export const READINESS_PROBE_KEY = "readiness/probe" as ObjectKey;

/**
 * A `Readiness` check that reports the storage driver's ability to answer:
 * `storage` is ready when a `head` of one fixed probe key completes, found
 * or not found (`ObjectNotFound` proves the driver reached its backend and
 * was allowed to ask). It never lists the store: a listing walks every
 * object, which no request path should pay for. Any other failure or
 * defect counts as not-ok (the runtime's `checkAll` absorbs them).
 */
export const storageReadinessCheck = (storage: Storage): ReadinessCheck => ({
  name: "storage",
  run: storage.head(READINESS_PROBE_KEY).pipe(
    Effect.as(true),
    Effect.catchTag("ObjectNotFound", () => Effect.succeed(true)),
    Effect.catchAllCause(() => Effect.succeed(false)),
  ),
});
