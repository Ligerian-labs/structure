import { describe, expect, test } from "bun:test";
import { Readiness, type ReadinessReport, Shutdown } from "@structure-ai/runtime";
import {
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Scope,
  TestClock,
  TestContext,
} from "effect";
import { JobQueueError, Scheduler, type SchedulerService } from "../src/index.js";
import { type WorkerLayerOptions, workerLayer } from "../src/layer.js";

/** Signals for call `index` (0-based); crashes clearly if the script is short. */
const signal = (fake: FakeScheduler, index: number): CallSignals => {
  const found = fake.signals[index];
  if (found === undefined) throw new Error(`no fake scheduler call ${index}`);
  return found;
};

/**
 * Drives `workerLayer` with a scriptable fake scheduler — no database. Each
 * `runWorker` call consumes one script entry:
 * - `fail` signals `started`, waits for its gate (so the test controls when
 *   the failure lands), then fails with a transient `JobQueueError`;
 * - `run` signals `started` and holds until interrupted;
 * - `drain` signals `started` and returns, like a clean shutdown drain.
 * Runs under `TestContext`, so the supervisor's restart backoff is virtual
 * time advanced with `TestClock.adjust`.
 */
type Step = "fail" | "run" | "drain";

interface CallSignals {
  readonly started: Deferred.Deferred<void>;
  readonly failed: Deferred.Deferred<void>;
  /** The test completes this to let a `fail` step land its failure. */
  readonly gate: Deferred.Deferred<void>;
}

interface FakeScheduler {
  readonly service: SchedulerService;
  readonly signals: ReadonlyArray<CallSignals>;
  /** Number of `runWorker` invocations observed so far. */
  readonly calls: () => number;
}

const makeFakeScheduler = (script: ReadonlyArray<Step>): Effect.Effect<FakeScheduler> =>
  Effect.gen(function* () {
    const signals: Array<CallSignals> = [];
    for (let index = 0; index < script.length; index += 1) {
      signals.push({
        started: yield* Deferred.make<void>(),
        failed: yield* Deferred.make<void>(),
        gate: yield* Deferred.make<void>(),
      });
    }
    let calls = 0;
    const service: SchedulerService = {
      register: () => Effect.void,
      schedule: () => Effect.die("fake scheduler: schedule not used"),
      recur: () => Effect.die("fake scheduler: recur not used"),
      cancel: () => Effect.die("fake scheduler: cancel not used"),
      depth: Effect.die("fake scheduler: depth not used"),
      lagMillis: Effect.die("fake scheduler: lagMillis not used"),
      registeredJobs: () => [],
      runWorker: () =>
        Effect.gen(function* () {
          const step = script[calls] as Step;
          calls += 1;
          const signal = signals[calls - 1] as CallSignals;
          yield* Deferred.succeed(signal.started, undefined);
          if (step === "fail") {
            yield* Deferred.await(signal.gate);
            yield* Deferred.succeed(signal.failed, undefined);
            return yield* new JobQueueError({ operation: "claim" });
          }
          if (step === "drain") return;
          return yield* Effect.never;
        }),
    };
    return { service, signals, calls: () => calls };
  });

const workerOk = (report: ReadinessReport): boolean =>
  report.checks.some((check) => check.name === "jobs-worker" && check.ok);

const runtimeLayers = Layer.merge(
  Readiness.layer,
  Shutdown.layer({ finalizerTimeout: Duration.seconds(1) }).pipe(Layer.provide(Readiness.layer)),
);

const buildLayers = (fake: FakeScheduler, options?: WorkerLayerOptions): Layer.Layer<Readiness> =>
  workerLayer(options).pipe(
    Layer.provide(Layer.succeed(Scheduler, fake.service)),
    Layer.provideMerge(runtimeLayers),
  );

describe("workerLayer supervision (issue #111)", () => {
  test("restarts the worker with bounded backoff and keeps readiness false only while down", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fake = yield* makeFakeScheduler(["fail", "fail", "run"]);
        const scope = yield* Scope.make();
        // Deterministic jitter: backoffMillis(attempt, () => 0, 1000, 60_000)
        // is 500ms for attempt 1 and 1000ms for attempt 2.
        const ctx = yield* Layer.buildWithScope(
          buildLayers(fake, {
            restart: { baseMillis: 1_000, capMillis: 60_000, random: () => 0 },
            pollInterval: "10 millis",
          }),
          scope,
        );
        const readiness = Context.get(ctx, Readiness);

        // First run starts healthy.
        yield* Deferred.await(signal(fake, 0).started);
        expect(yield* readiness.checkAll.pipe(Effect.map(workerOk))).toBe(true);

        // Land the first failure: the supervisor backs off 500ms, and while
        // it does the worker reports not ready.
        yield* Deferred.succeed(signal(fake, 0).gate, undefined);
        yield* Deferred.await(signal(fake, 0).failed);
        yield* TestClock.adjust("1 millis");
        expect(yield* readiness.checkAll.pipe(Effect.map(workerOk))).toBe(false);
        yield* TestClock.adjust("400 millis");
        expect(yield* readiness.checkAll.pipe(Effect.map(workerOk))).toBe(false);
        yield* TestClock.adjust("200 millis");
        yield* Deferred.await(signal(fake, 1).started);
        expect(yield* readiness.checkAll.pipe(Effect.map(workerOk))).toBe(true);

        // Second consecutive failure backs off twice as long (1000ms).
        yield* Deferred.succeed(signal(fake, 1).gate, undefined);
        yield* Deferred.await(signal(fake, 1).failed);
        yield* TestClock.adjust("600 millis");
        expect(yield* readiness.checkAll.pipe(Effect.map(workerOk))).toBe(false);
        yield* TestClock.adjust("500 millis");
        yield* Deferred.await(signal(fake, 2).started);
        expect(fake.calls()).toBe(3);
        expect(yield* readiness.checkAll.pipe(Effect.map(workerOk))).toBe(true);

        // Scope close interrupts the held run; the worker goes not ready.
        yield* Scope.close(scope, Exit.void);
        expect(yield* readiness.checkAll.pipe(Effect.map(workerOk))).toBe(false);
      }).pipe(Effect.provide(TestContext.TestContext)),
    );
  });

  test("restart: false keeps the one-shot stop on failure", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fake = yield* makeFakeScheduler(["fail", "run"]);
        const scope = yield* Scope.make();
        const ctx = yield* Layer.buildWithScope(
          buildLayers(fake, { restart: false, pollInterval: "10 millis" }),
          scope,
        );
        const readiness = Context.get(ctx, Readiness);
        yield* Deferred.await(signal(fake, 0).started);
        yield* Deferred.succeed(signal(fake, 0).gate, undefined);
        yield* Deferred.await(signal(fake, 0).failed);
        yield* TestClock.adjust("10 seconds");
        expect(fake.calls()).toBe(1);
        expect(yield* readiness.checkAll.pipe(Effect.map(workerOk))).toBe(false);
        yield* Scope.close(scope, Exit.void);
      }).pipe(Effect.provide(TestContext.TestContext)),
    );
  });

  test("a cleanly drained worker is not restarted", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fake = yield* makeFakeScheduler(["drain", "run"]);
        const scope = yield* Scope.make();
        const ctx = yield* Layer.buildWithScope(
          buildLayers(fake, { restart: { baseMillis: 1_000, random: () => 0 } }),
          scope,
        );
        const readiness = Context.get(ctx, Readiness);
        yield* Deferred.await(signal(fake, 0).started);
        yield* TestClock.adjust("10 seconds");
        expect(fake.calls()).toBe(1);
        expect(yield* readiness.checkAll.pipe(Effect.map(workerOk))).toBe(false);
        yield* Scope.close(scope, Exit.void);
      }).pipe(Effect.provide(TestContext.TestContext)),
    );
  });

  test("api role starts no worker and registers no readiness check", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fake = yield* makeFakeScheduler(["run"]);
        const scope = yield* Scope.make();
        const ctx = yield* Layer.buildWithScope(buildLayers(fake, { role: "api" }), scope);
        const readiness = Context.get(ctx, Readiness);
        yield* TestClock.adjust("100 millis");
        expect(fake.calls()).toBe(0);
        const report = yield* readiness.checkAll;
        expect(report.checks).toBeEmpty();
        yield* Scope.close(scope, Exit.void);
      }).pipe(Effect.provide(TestContext.TestContext)),
    );
  });
});
