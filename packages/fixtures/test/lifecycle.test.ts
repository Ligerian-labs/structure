import { expect, test } from "bun:test";
import { HandlerRegistry, layer } from "@structure-ai/cqrs";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, TestClock, TestContext } from "effect";
import { cleanup, defineFixture, run } from "../src/index.js";

const bus = layer.pipe(Layer.provide(HandlerRegistry.layer()));

test("run deadline includes readiness and preserves a partial completion receipt", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const reached = yield* Deferred.make<void>();
      const task = yield* run({
        fixtures: { base: defineFixture({ key: "base", create: () => Effect.succeed(1) }) },
        enabled: true,
        timeoutMs: 100,
        ready: () => Deferred.succeed(reached, undefined).pipe(Effect.zipRight(Effect.never)),
      }).pipe(Effect.either, Effect.fork);
      yield* Deferred.await(reached);
      yield* TestClock.adjust(100);
      return yield* Fiber.join(task);
    }).pipe(Effect.provide(bus), Effect.provide(TestContext.TestContext)),
  );
  expect(result._tag).toBe("Left");
  if (result._tag === "Left") {
    expect(result.left.reason).toBe("timeout");
    expect(result.left.completed).toEqual(["base"]);
    expect(result.left.step).toBe("ready");
  }
});

test("interrupting a run interrupts owned work and does not retry it", async () => {
  let started = 0;
  let stopped = false;
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const reached = yield* Deferred.make<void>();
      const waiting = defineFixture({
        key: "waiting",
        create: () =>
          Effect.gen(function* () {
            started++;
            yield* Deferred.succeed(reached, undefined);
            yield* Effect.never;
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                stopped = true;
              }),
            ),
          ),
      });
      const task = yield* run({
        fixtures: { waiting },
        enabled: true,
        ready: () => Effect.void,
      }).pipe(Effect.fork);
      yield* Deferred.await(reached);
      return yield* Fiber.interrupt(task);
    }).pipe(Effect.provide(bus)),
  );
  expect(Exit.isFailure(result) && Cause.isInterruptedOnly(result.cause)).toBe(true);
  expect(started).toBe(1);
  expect(stopped).toBe(true);
});

test("cleanup is explicit, capability-guarded and scoped to one run UUID", async () => {
  const removed: Array<string> = [];
  const runId = crypto.randomUUID();
  const remove = (id: string) =>
    Effect.sync(() => {
      removed.push(id);
    });
  for (const options of [
    { runId, remove },
    { runId: "all", enabled: true, remove },
  ]) {
    expect((await Effect.runPromise(cleanup(options).pipe(Effect.either)))._tag).toBe("Left");
  }
  expect(removed).toHaveLength(0);
  await Effect.runPromise(cleanup({ runId, remove, enabled: true }));
  expect(removed).toEqual([runId]);
});

test("fixture context never converts a defect into a recoverable failure", async () => {
  const defect = new Error("fixture bug");
  const result = await Effect.runPromiseExit(
    run({
      enabled: true,
      fixtures: { broken: defineFixture({ key: "broken", create: () => Effect.die(defect) }) },
      ready: () => Effect.void,
    }).pipe(Effect.provide(bus)),
  );
  expect(Exit.isFailure(result)).toBe(true);
  if (Exit.isFailure(result)) {
    expect([...Cause.defects(result.cause)]).toEqual([defect]);
    expect([...Cause.failures(result.cause)]).toEqual([]);
  }
});
