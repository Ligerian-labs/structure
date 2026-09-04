import { expect, test } from "bun:test";
import { Correlation } from "@structure-ai/observability";
import { Readiness } from "@structure-ai/runtime";
import { Effect, Fiber, Schema as S } from "effect";
import {
  defineJob,
  type JobContext,
  type JobFailure,
  type JobHandler,
  type SchedulerService,
} from "../src/index.js";

export interface SchedulerHarness {
  readonly scheduler: SchedulerService;
  readonly clock: { value: Date };
  readonly startWorker: (options?: {
    readonly batchSize?: number;
    readonly concurrency?: number;
    readonly pollMillis?: number;
    readonly leaseMillis?: number;
  }) => Promise<Fiber.RuntimeFiber<void, never>>;
  readonly stopWorker: () => Promise<void>;
  readonly deadLetters: () => Promise<ReadonlyArray<{ job_name: string; attempts: number }>>;
  readonly close: () => Promise<void>;
}

export type MakeHarness = () => Promise<SchedulerHarness>;

const waitFor = async (
  predicate: () => boolean,
  onPoll: () => void,
  timeoutMillis = 10_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMillis;
  while (!predicate() && Date.now() < deadline) {
    onPoll();
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const pingPayload = S.parseJson(S.Struct({ message: S.String }));

export const registerSchedulerScenarios = (make: MakeHarness): void => {
  const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

  const testJob = defineJob({ name: "test.ping", payloadSchema: pingPayload }, () => Effect.void);

  const recorderJob = (
    onCall: (payload: { message: string }, context: JobContext) => void,
  ): JobHandler<{ message: string }> => ({
    name: "test.ping",
    payloadSchema: pingPayload,
    handle: (payload, context) =>
      Effect.sync(() => {
        onCall(payload, context);
      }),
  });

  test("delayed jobs fire when the clock reaches them", async () => {
    const harness = await make();
    try {
      const calls: Array<string> = [];
      await run(harness.scheduler.register(recorderJob((payload) => calls.push(payload.message))));
      const worker = await harness.startWorker({ pollMillis: 10 });
      await run(
        harness.scheduler.schedule(testJob, { message: "hello-delayed" }, { delay: "1 hour" }),
      );
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(calls).toEqual([]);
      harness.clock.value = new Date(harness.clock.value.getTime() + 3_600_001);
      await waitFor(
        () => calls.length > 0,
        () => undefined,
      );
      expect(calls).toEqual(["hello-delayed"]);
      await harness.stopWorker();
      await Effect.runPromise(Fiber.await(worker));
    } finally {
      await harness.close();
    }
  });

  test("cron jobs requeue with the next occurrence after firing", async () => {
    const harness = await make();
    try {
      const scheduled: Array<Date> = [];
      await run(
        harness.scheduler.register(
          recorderJob((_payload, context) => scheduled.push(context.scheduledFor)),
        ),
      );
      const worker = await harness.startWorker({ pollMillis: 10 });
      await run(
        harness.scheduler.recur(
          testJob,
          { message: "tick" },
          { cron: "*/5 * * * *", scheduleKey: "tick-5" },
        ),
      );
      harness.clock.value = new Date(harness.clock.value.getTime() + 5 * 60_001);
      await waitFor(
        () => scheduled.length > 0,
        () => undefined,
      );
      expect(scheduled.length).toBe(1);
      // One recurring row remains, requeued for the next 5-minute slot.
      expect(await run(harness.scheduler.depth)).toBe(1);
      await harness.stopWorker();
      await Effect.runPromise(Fiber.await(worker));
    } finally {
      await harness.close();
    }
  });

  test("SKIP LOCKED: parallel workers execute each job exactly once", async () => {
    const harness = await make();
    try {
      const executed = new Set<string>();
      await run(
        harness.scheduler.register({
          name: "test.ping",
          payloadSchema: pingPayload,
          handle: (payload) =>
            Effect.gen(function* () {
              yield* Effect.sleep("15 millis");
              executed.add(payload.message);
            }),
        }),
      );
      const workerA = await harness.startWorker({ pollMillis: 5, batchSize: 3 });
      const workerB = await harness.startWorker({ pollMillis: 5, batchSize: 3 });
      for (let index = 0; index < 12; index++) {
        await run(harness.scheduler.schedule(testJob, { message: `job-${index}` }));
      }
      await waitFor(
        () => executed.size >= 12,
        () => undefined,
        15_000,
      );
      expect(executed.size).toBe(12);
      expect(await run(harness.scheduler.depth)).toBe(0);
      await harness.stopWorker();
      await Effect.runPromise(Fiber.await(workerA));
      await Effect.runPromise(Fiber.await(workerB));
    } finally {
      await harness.close();
    }
  });

  test("the concurrency bound caps simultaneously running handlers, whatever the backlog", async () => {
    const harness = await make();
    try {
      let running = 0;
      let peak = 0;
      const executed = new Set<string>();
      await run(
        harness.scheduler.register({
          name: "test.ping",
          payloadSchema: pingPayload,
          handle: (payload) =>
            Effect.gen(function* () {
              running += 1;
              peak = Math.max(peak, running);
              yield* Effect.sleep("60 millis");
              running -= 1;
              executed.add(payload.message);
            }),
        }),
      );
      // A backlog far larger than the bound: 40 due jobs, batches of 5.
      for (let index = 0; index < 40; index++) {
        await run(harness.scheduler.schedule(testJob, { message: `bulk-${index}` }));
      }
      const worker = await harness.startWorker({ pollMillis: 5, batchSize: 5 });
      await waitFor(
        () => executed.size >= 40,
        () => undefined,
        15_000,
      );
      expect(executed.size).toBe(40);
      expect(peak).toBeLessThanOrEqual(5);
      expect(peak).toBeGreaterThan(1);
      await harness.stopWorker();
      await Effect.runPromise(Fiber.await(worker));
    } finally {
      await harness.close();
    }
  });

  test("an explicit concurrency lower than the batch size is the ceiling", async () => {
    const harness = await make();
    try {
      let running = 0;
      let peak = 0;
      const executed = new Set<string>();
      await run(
        harness.scheduler.register({
          name: "test.ping",
          payloadSchema: pingPayload,
          handle: (payload) =>
            Effect.gen(function* () {
              running += 1;
              peak = Math.max(peak, running);
              yield* Effect.sleep("40 millis");
              running -= 1;
              executed.add(payload.message);
            }),
        }),
      );
      for (let index = 0; index < 12; index++) {
        await run(harness.scheduler.schedule(testJob, { message: `narrow-${index}` }));
      }
      const worker = await harness.startWorker({ pollMillis: 5, batchSize: 10, concurrency: 2 });
      await waitFor(
        () => executed.size >= 12,
        () => undefined,
        15_000,
      );
      expect(executed.size).toBe(12);
      expect(peak).toBeLessThanOrEqual(2);
      await harness.stopWorker();
      await Effect.runPromise(Fiber.await(worker));
    } finally {
      await harness.close();
    }
  });

  test("transient failures retry with backoff; permanent failures dead-letter immediately", async () => {
    const harness = await make();
    try {
      let attempts = 0;
      await run(
        harness.scheduler.register({
          name: "test.ping",
          payloadSchema: pingPayload,
          handle: (payload) =>
            Effect.suspend((): Effect.Effect<void, JobFailure> => {
              attempts += 1;
              if (payload.message === "flaky") {
                return attempts < 2
                  ? Effect.fail({ reason: "db-pending", classification: "transient" })
                  : Effect.void;
              }
              return Effect.fail({ reason: "bad-input", classification: "permanent" });
            }),
        }),
      );
      const worker = await harness.startWorker({ pollMillis: 10 });
      await run(harness.scheduler.schedule(testJob, { message: "flaky" }));
      await run(harness.scheduler.schedule(testJob, { message: "doomed" }));

      let dead: ReadonlyArray<{ job_name: string; attempts: number }> = [];
      // Advance the fake clock in the wait loop so retry backoffs come due.
      const deadline = Date.now() + 15_000;
      while (dead.length < 1 && Date.now() < deadline) {
        harness.clock.value = new Date(harness.clock.value.getTime() + 2_000);
        dead = await harness.deadLetters();
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      expect(dead.map((letter) => letter.job_name)).toEqual(["test.ping"]);
      expect(dead[0]?.attempts).toBe(1);
      // flaky failed once transiently, succeeded on retry; doomed failed once permanently.
      expect(attempts).toBe(3);
      await harness.stopWorker();
      await Effect.runPromise(Fiber.await(worker));
    } finally {
      await harness.close();
    }
  });

  test("correlation ids flow from the scheduling site into execution", async () => {
    const harness = await make();
    try {
      const seen: Array<string | undefined> = [];
      await run(
        harness.scheduler.register({
          name: "test.ping",
          payloadSchema: pingPayload,
          handle: () =>
            Effect.flatMap(Correlation.current, (context) =>
              Effect.sync(() => {
                seen.push(context.correlationId);
              }),
            ),
        }),
      );
      const worker = await harness.startWorker({ pollMillis: 10 });
      await run(
        Correlation.within({ correlationId: "corr-42" })(
          harness.scheduler.schedule(testJob, { message: "traced" }),
        ),
      );
      await waitFor(
        () => seen.length > 0,
        () => undefined,
      );
      expect(seen).toEqual(["corr-42"]);
      await harness.stopWorker();
      await Effect.runPromise(Fiber.await(worker));
    } finally {
      await harness.close();
    }
  });

  test("graceful drain: shutdown waits for in-flight jobs", async () => {
    const harness = await make();
    try {
      let finished = false;
      await run(
        harness.scheduler.register({
          name: "test.ping",
          payloadSchema: pingPayload,
          handle: () =>
            Effect.sleep("400 millis").pipe(
              Effect.zipRight(
                Effect.sync(() => {
                  finished = true;
                }),
              ),
            ),
        }),
      );
      const worker = await harness.startWorker({ pollMillis: 10 });
      await run(harness.scheduler.schedule(testJob, { message: "slow" }));
      await waitFor(
        () => false,
        () => undefined,
        100,
      ); // let the claim land
      const triggeredAt = Date.now();
      await harness.stopWorker();
      const exit = await Effect.runPromise(Fiber.await(worker));
      const drainMillis = Date.now() - triggeredAt;
      expect(exit._tag === "Success" ? true : exit._tag).toBe(true);
      expect(finished).toBe(true);
      expect(drainMillis).toBeGreaterThanOrEqual(300);
    } finally {
      await harness.close();
    }
  });

  test("cancel removes a pending job before it fires", async () => {
    const harness = await make();
    try {
      const calls: Array<string> = [];
      await run(harness.scheduler.register(recorderJob((payload) => calls.push(payload.message))));
      const worker = await harness.startWorker({ pollMillis: 10 });
      const jobId = await run(
        harness.scheduler.schedule(testJob, { message: "cancelled" }, { delay: "1 hour" }),
      );
      await run(harness.scheduler.cancel(jobId));
      harness.clock.value = new Date(harness.clock.value.getTime() + 3_600_001);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(calls).toEqual([]);
      await harness.stopWorker();
      await Effect.runPromise(Fiber.await(worker));
    } finally {
      await harness.close();
    }
  });

  void Readiness;
};
