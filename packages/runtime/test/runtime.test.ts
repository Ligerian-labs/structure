import { describe, expect, test } from "bun:test";
import { Settings, toLayer } from "@structure/config";
import { layerSilent } from "@structure/observability";
import { Context, Duration, Effect, Fiber, Layer } from "effect";
import { Readiness, runToCompletion, Shutdown, type ShutdownOptions } from "../src/index.js";

const runReadiness = <A>(effect: Effect.Effect<A, never, Readiness>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(Readiness.layer)));

describe("Readiness", () => {
  test("starts not ready and flips with setReady/setUnready", async () => {
    await runReadiness(
      Effect.gen(function* () {
        const readiness = yield* Readiness;
        expect(yield* readiness.isReady).toBe(false);
        expect((yield* readiness.checkAll).ready).toBe(false);
        yield* readiness.setReady;
        expect(yield* readiness.isReady).toBe(true);
        expect((yield* readiness.checkAll).ready).toBe(true);
        yield* readiness.setUnready;
        expect((yield* readiness.checkAll).ready).toBe(false);
      }),
    );
  });

  test("a failing check makes checkAll not ready and lists it as ok:false", async () => {
    await runReadiness(
      Effect.gen(function* () {
        const readiness = yield* Readiness;
        yield* readiness.setReady;
        yield* readiness.register({ name: "database", run: Effect.succeed(true) });
        yield* readiness.register({ name: "queue", run: Effect.succeed(false) });
        const report = yield* readiness.checkAll;
        expect(report.ready).toBe(false);
        expect(report.checks).toEqual([
          { name: "database", ok: true },
          { name: "queue", ok: false },
        ]);
      }),
    );
  });

  test("a defect-throwing check counts as not-ok and never crashes", async () => {
    await runReadiness(
      Effect.gen(function* () {
        const readiness = yield* Readiness;
        yield* readiness.setReady;
        yield* readiness.register({
          name: "exploding",
          run: Effect.sync((): boolean => {
            throw new Error("boom");
          }),
        });
        const report = yield* readiness.checkAll;
        expect(report.ready).toBe(false);
        expect(report.checks).toEqual([{ name: "exploding", ok: false }]);
      }),
    );
  });
});

const shutdownLayers = (options?: ShutdownOptions): Layer.Layer<Shutdown | Readiness> =>
  Layer.mergeAll(Shutdown.layer(options).pipe(Layer.provideMerge(Readiness.layer)), layerSilent);

const runShutdown = <A>(
  effect: Effect.Effect<A, never, Shutdown | Readiness>,
  options?: ShutdownOptions,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(shutdownLayers(options))));

describe("Shutdown", () => {
  test("finalizers run in reverse order exactly once even when triggered twice", async () => {
    const log: Array<string> = [];
    await runShutdown(
      Effect.gen(function* () {
        const shutdown = yield* Shutdown;
        for (const name of ["a", "b", "c"]) {
          yield* shutdown.onShutdown(
            name,
            Effect.sync(() => {
              log.push(name);
            }),
          );
        }
        yield* shutdown.trigger("first");
        yield* shutdown.trigger("second");
        expect(yield* shutdown.isShuttingDown).toBe(true);
        expect(yield* shutdown.awaitShutdown).toBe("first");
      }),
    );
    expect(log).toEqual(["c", "b", "a"]);
  });

  test("a slow finalizer beyond the timeout is skipped and the rest still run", async () => {
    const log: Array<string> = [];
    await runShutdown(
      Effect.gen(function* () {
        const shutdown = yield* Shutdown;
        yield* shutdown.onShutdown(
          "fast-1",
          Effect.sync(() => {
            log.push("fast-1");
          }),
        );
        yield* shutdown.onShutdown("slow", Effect.sleep(Duration.seconds(10)));
        yield* shutdown.onShutdown(
          "fast-2",
          Effect.sync(() => {
            log.push("fast-2");
          }),
        );
        yield* shutdown.trigger("timeout-test");
      }),
      { finalizerTimeout: Duration.millis(30) },
    );
    expect(log).toEqual(["fast-2", "fast-1"]);
  });

  test("a failing finalizer is skipped and the rest still run", async () => {
    const log: Array<string> = [];
    await runShutdown(
      Effect.gen(function* () {
        const shutdown = yield* Shutdown;
        yield* shutdown.onShutdown(
          "healthy",
          Effect.sync(() => {
            log.push("healthy");
          }),
        );
        yield* shutdown.onShutdown(
          "broken",
          Effect.sync(() => {
            throw new Error("finalizer defect");
          }),
        );
        yield* shutdown.trigger("failure-test");
      }),
    );
    expect(log).toEqual(["healthy"]);
  });

  test("trigger flips Readiness to unready", async () => {
    await runShutdown(
      Effect.gen(function* () {
        const readiness = yield* Readiness;
        const shutdown = yield* Shutdown;
        yield* readiness.setReady;
        expect(yield* readiness.isReady).toBe(true);
        yield* shutdown.trigger("SIGTERM");
        expect(yield* readiness.isReady).toBe(false);
      }),
    );
  });

  test("awaitShutdown blocks until triggered and resolves with the reason", async () => {
    await runShutdown(
      Effect.gen(function* () {
        const shutdown = yield* Shutdown;
        const waiter = yield* Effect.fork(shutdown.awaitShutdown);
        yield* shutdown.trigger("SIGINT");
        expect(yield* Fiber.join(waiter)).toBe("SIGINT");
      }),
    );
  });
});

class AppConfig extends Context.Tag("@structure/runtime/test/AppConfig")<
  AppConfig,
  { readonly port: number; readonly name: string }
>() {}

const appSettings = Settings.struct({
  port: Settings.port("STRUCTURE_RUNTIME_TEST_PORT"),
  name: Settings.string("STRUCTURE_RUNTIME_TEST_NAME"),
});

describe("runToCompletion", () => {
  test("missing config surfaces ConfigInvalid with all issues", async () => {
    const layers = toLayer(AppConfig, appSettings, { overrides: {} });
    const program = Effect.asVoid(AppConfig);
    const outcome = await Effect.runPromise(runToCompletion(program, layers));
    expect(outcome._tag).toBe("ConfigInvalid");
    if (outcome._tag === "ConfigInvalid") {
      const paths = outcome.issues.map((issue) => issue.path);
      expect(paths).toContain("STRUCTURE_RUNTIME_TEST_PORT");
      expect(paths).toContain("STRUCTURE_RUNTIME_TEST_NAME");
      expect(outcome.issues).toHaveLength(2);
    }
  });

  test("a succeeding program returns Success", async () => {
    const layers = toLayer(AppConfig, appSettings, {
      overrides: { STRUCTURE_RUNTIME_TEST_PORT: "8080", STRUCTURE_RUNTIME_TEST_NAME: "svc" },
    });
    const program = Effect.gen(function* () {
      const config = yield* AppConfig;
      expect(config.port).toBe(8080);
      expect(config.name).toBe("svc");
    });
    const outcome = await Effect.runPromise(runToCompletion(program, layers));
    expect(outcome).toEqual({ _tag: "Success" });
  });

  test("a non-config failure maps to Failed with its cause", async () => {
    const program = Effect.fail(new Error("business failure"));
    const outcome = await Effect.runPromise(runToCompletion(program, Layer.empty));
    expect(outcome._tag).toBe("Failed");
  });
});
