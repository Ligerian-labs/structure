import { describe, expect, test } from "bun:test";
import { Settings, toLayer } from "@structure-ai/config";
import { layerSilent } from "@structure-ai/observability";
import {
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  LogLevel,
  Ref,
} from "effect";
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

  test("a finalizer beyond the timeout is logged at error level, by name, with its budget", async () => {
    const records: Array<{ level: string; message: string; annotations: Record<string, unknown> }> =
      [];
    const recording = Logger.replace(
      Logger.defaultLogger,
      Logger.make(({ logLevel, message, annotations }) => {
        records.push({
          level: logLevel.label,
          message: Array.isArray(message) ? String(message[0]) : String(message),
          annotations: Object.fromEntries(annotations),
        });
      }),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const shutdown = yield* Shutdown;
        yield* shutdown.onShutdown("slow-drain", Effect.sleep(Duration.seconds(10)));
        yield* shutdown.trigger("timeout-log-test");
      }).pipe(
        Effect.provide(
          Shutdown.layer({ finalizerTimeout: Duration.millis(30) }).pipe(
            Layer.provide(Readiness.layer),
          ),
        ),
        Effect.provide(recording),
        Logger.withMinimumLogLevel(LogLevel.Debug),
      ),
    );
    const overrun = records.find((record) => record.message.includes("slow-drain"));
    expect(overrun).toBeDefined();
    expect(overrun?.level).toBe(LogLevel.Error.label);
    expect(overrun?.annotations.finalizer).toBe("slow-drain");
    expect(overrun?.annotations.finalizerTimeoutMillis).toBe(30);
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

  test("awaitShutdown resolves only once every finalizer has drained", async () => {
    const log: Array<string> = [];
    await runShutdown(
      Effect.gen(function* () {
        const shutdown = yield* Shutdown;
        yield* shutdown.onShutdown(
          "slow-ish",
          Effect.sleep(Duration.millis(20)).pipe(
            Effect.andThen(
              Effect.sync(() => {
                log.push("slow-ish");
              }),
            ),
          ),
        );
        const waiter = yield* Effect.fork(
          shutdown.awaitShutdown.pipe(Effect.map((reason) => ({ reason, seen: [...log] }))),
        );
        yield* Effect.fork(shutdown.trigger("first"));
        expect(yield* Fiber.join(waiter)).toEqual({ reason: "first", seen: ["slow-ish"] });
      }),
    );
  });

  test("a second trigger returns only after the running drain completed", async () => {
    const log: Array<string> = [];
    await runShutdown(
      Effect.gen(function* () {
        const shutdown = yield* Shutdown;
        yield* shutdown.onShutdown(
          "slow-ish",
          Effect.sleep(Duration.millis(20)).pipe(
            Effect.andThen(
              Effect.sync(() => {
                log.push("slow-ish");
              }),
            ),
          ),
        );
        const first = yield* Effect.fork(shutdown.trigger("first"));
        yield* shutdown.trigger("second");
        expect(log).toEqual(["slow-ish"]);
        yield* Fiber.join(first);
      }),
    );
  });

  test("the per-finalizer timeout holds when trigger runs inside an interruption handler", async () => {
    const log: Array<string> = [];
    await runShutdown(
      Effect.gen(function* () {
        const shutdown = yield* Shutdown;
        yield* shutdown.onShutdown(
          "fast",
          Effect.sync(() => {
            log.push("fast");
          }),
        );
        yield* shutdown.onShutdown("hung", Effect.never);
        const fiber = yield* Effect.fork(
          Effect.never.pipe(Effect.onInterrupt(() => shutdown.trigger("interrupted"))),
        );
        yield* Effect.yieldNow();
        const started = Date.now();
        yield* Fiber.interrupt(fiber);
        expect(Date.now() - started).toBeLessThan(1_000);
        expect(log).toEqual(["fast"]);
      }),
      { finalizerTimeout: Duration.millis(30) },
    );
  });
});

describe("runToCompletion with a Shutdown coordinator", () => {
  const layers = shutdownLayers();

  interface Observed {
    readonly name: string;
    readonly ready: boolean;
  }

  const shutdownProgram = (options: {
    readonly ready: Deferred.Deferred<void>;
    readonly observed: Ref.Ref<ReadonlyArray<Observed>>;
    readonly resolved?: Deferred.Deferred<string>;
  }): Effect.Effect<void, never, Shutdown | Readiness> =>
    Effect.gen(function* () {
      const readiness = yield* Readiness;
      const shutdown = yield* Shutdown;
      for (const name of ["a", "b", "c"]) {
        yield* shutdown.onShutdown(
          name,
          Effect.gen(function* () {
            const ready = yield* readiness.isReady;
            yield* Ref.update(options.observed, (list) => [...list, { name, ready }]);
          }),
        );
      }
      yield* readiness.setReady;
      yield* Deferred.succeed(options.ready, undefined);
      const reason = yield* shutdown.awaitShutdown;
      if (options.resolved !== undefined) yield* Deferred.succeed(options.resolved, reason);
    });

  test("interrupting the main fiber runs finalizers in reverse order after flipping readiness", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const ready = yield* Deferred.make<void>();
        const resolved = yield* Deferred.make<string>();
        const observed = yield* Ref.make<ReadonlyArray<Observed>>([]);
        const main = yield* Effect.fork(
          runToCompletion(shutdownProgram({ ready, observed, resolved }), layers),
        );
        yield* Deferred.await(ready);
        const exit = yield* Fiber.interrupt(main);
        expect(Exit.isInterrupted(exit)).toBe(true);
        expect(yield* Ref.get(observed)).toEqual([
          { name: "c", ready: false },
          { name: "b", ready: false },
          { name: "a", ready: false },
        ]);
        // The program itself saw awaitShutdown resolve and ran to its end.
        expect(yield* Deferred.await(resolved)).toBe("interrupted");
      }),
    );
  });

  test("an injected signal resolves awaitShutdown with its name once the finalizers drained", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const ready = yield* Deferred.make<void>();
        const resolved = yield* Deferred.make<string>();
        const stop = yield* Deferred.make<string>();
        const observed = yield* Ref.make<ReadonlyArray<Observed>>([]);
        const main = yield* Effect.fork(
          runToCompletion(shutdownProgram({ ready, observed, resolved }), layers, {
            signal: Deferred.await(stop),
          }),
        );
        yield* Deferred.await(ready);
        yield* Deferred.succeed(stop, "SIGTERM");
        expect(yield* Deferred.await(resolved)).toBe("SIGTERM");
        expect((yield* Ref.get(observed)).map((entry) => entry.name)).toEqual(["c", "b", "a"]);
        return yield* Fiber.join(main);
      }),
    );
    expect(outcome).toEqual({ _tag: "Success" });
  });

  test("an injected signal stops a program that never ends on its own, as Success", async () => {
    const log: Array<string> = [];
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const stop = yield* Deferred.make<string>();
        const program = Effect.gen(function* () {
          const shutdown = yield* Shutdown;
          yield* shutdown.onShutdown(
            "server",
            Effect.sync(() => {
              log.push("server");
            }),
          );
          yield* Deferred.succeed(stop, "SIGINT");
          yield* Effect.never;
        });
        return yield* runToCompletion(program, layers, { signal: Deferred.await(stop) });
      }),
    );
    expect(outcome).toEqual({ _tag: "Success" });
    expect(log).toEqual(["server"]);
  });

  test("without a Shutdown service the program runs untouched", async () => {
    const outcome = await Effect.runPromise(
      runToCompletion(Effect.void, Layer.empty, { signal: Effect.succeed("SIGTERM") }),
    );
    expect(outcome).toEqual({ _tag: "Success" });
  });
});

describe("launch signals", () => {
  test("SIGTERM resolves awaitShutdown with the signal name after draining the finalizers", async () => {
    const fixture = new URL("./fixtures/launch-signal.ts", import.meta.url).pathname;
    const proc = Bun.spawn([process.execPath, "run", fixture], { stdout: "pipe", stderr: "pipe" });
    const lines: Array<string> = [];
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    const readUntil = async (predicate: () => boolean): Promise<void> => {
      while (!predicate()) {
        const chunk = await reader.read();
        if (chunk.done) return;
        buffered += decoder.decode(chunk.value, { stream: true });
        const parts = buffered.split("\n");
        buffered = parts.pop() ?? "";
        lines.push(...parts);
      }
    };
    await readUntil(() => lines.includes("ready"));
    expect(lines).toEqual(["ready"]);
    proc.kill("SIGTERM");
    await readUntil(() => false);
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(stderr).toBe("");
    expect(lines).toEqual([
      "ready",
      "finalizer drain-jobs ready=false",
      "finalizer close-db ready=false",
      "shutdown SIGTERM",
    ]);
    expect(code).toBe(0);
  }, 20_000);
});

class AppConfig extends Context.Tag("@structure-ai/runtime/test/AppConfig")<
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

const launchFixture = async (
  logFormat: "json" | "pretty",
): Promise<{ readonly code: number; readonly stdout: Array<string>; readonly stderr: string }> => {
  const fixture = new URL("./fixtures/launch-logger.ts", import.meta.url).pathname;
  const proc = Bun.spawn([process.execPath, "run", fixture, logFormat], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout: stdout.split("\n").filter((line) => line.length > 0), stderr };
};

describe("launch", () => {
  test("a launched app with the JSON logger emits exactly one line per record", async () => {
    const { code, stdout, stderr } = await launchFixture("json");
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout).toHaveLength(1);
    const record = JSON.parse(stdout[0] ?? "") as { event: string; level: string };
    expect(record.event).toBe("launched");
    expect(record.level).toBe("INFO");
  }, 20_000);

  test("a launched app with the pretty logger emits exactly one pretty line per record", async () => {
    const { code, stdout, stderr } = await launchFixture("pretty");
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout).toHaveLength(1);
    expect(stdout[0]).toContain("launched");
    expect(() => JSON.parse(stdout[0] ?? "")).toThrow();
  }, 20_000);
});
