import { describe, expect, test } from "bun:test";
import { Effect, FiberRef, HashSet, Layer, Logger, LogLevel, Redacted } from "effect";
import {
  Correlation,
  type JsonLoggerOptions,
  type LogRecord,
  layer,
  layerJson,
  layerPretty,
  Metrics,
  makeJsonLogger,
  ServiceMeta,
} from "../src/index.js";

const service = { name: "svc", version: "1.2.3", instance: "i-1" };

const captureLogger = (options?: JsonLoggerOptions) => {
  const lines: Array<string> = [];
  const logger = makeJsonLogger(service, (line) => lines.push(line), options);
  const records = () => lines.map((l) => JSON.parse(l) as LogRecord);
  return { layer: Logger.replace(Logger.defaultLogger, logger), records };
};

describe("structured logging", () => {
  test("emits one JSON line with stable fields", async () => {
    const cap = captureLogger();
    await Effect.runPromise(
      Effect.log("user accepted").pipe(
        Effect.annotateLogs({ userId: "u-1" }),
        Effect.provide(cap.layer),
      ),
    );
    const [record] = cap.records();
    expect(record?.event).toBe("user accepted");
    expect(record?.level).toBe("INFO");
    expect(record?.service).toEqual(service);
    expect(record?.annotations.userId).toBe("u-1");
    expect(new Date(record?.ts ?? "").toISOString()).toBe(record?.ts ?? "");
  });

  test("renders failure causes once and truncates long strings", async () => {
    const cap = captureLogger();
    await Effect.runPromise(
      Effect.logError("boom happened", "x".repeat(5000)).pipe(Effect.provide(cap.layer)),
    );
    const [record] = cap.records();
    expect(record?.level).toBe("ERROR");
    expect((record?.event ?? "").length).toBeLessThan(4200);
    expect(record?.event).toContain("…[truncated]");
  });
});

describe("structured annotations", () => {
  const logWith = async (annotations: Record<string, unknown>, options?: JsonLoggerOptions) => {
    const cap = captureLogger(options);
    await Effect.runPromise(
      Effect.log("evt").pipe(Effect.annotateLogs(annotations), Effect.provide(cap.layer)),
    );
    const [record] = cap.records();
    return record?.annotations ?? {};
  };
  const nested = (ann: Record<string, unknown>, path: ReadonlyArray<string>): unknown =>
    path.reduce<unknown>((acc, key) => (acc as Record<string, unknown>)[key], ann);

  test("renders plain objects and arrays as JSON structure", async () => {
    const ann = await logWith({ req: { a: 1, nested: { b: "x" }, tags: ["t1", "t2"] } });
    expect(nested(ann, ["req", "nested", "b"])).toBe("x");
    expect(nested(ann, ["req", "a"])).toBe(1);
    expect(nested(ann, ["req", "tags"])).toEqual(["t1", "t2"]);
  });

  test("keeps Redacted, Date, Error, and exotic values readable at any depth", async () => {
    const err = new Error("bad thing");
    const ann = await logWith({
      p: {
        secret: Redacted.make("hunter2"),
        at: new Date("2024-01-02T03:04:05.000Z"),
        err,
        url: new URL("https://example.test/path"),
        big: 10n,
        set: new Set([1, 2]),
        map: new Map([["k", "v"]]),
      },
    });
    expect(nested(ann, ["p", "secret"])).toBe("<redacted>");
    expect(nested(ann, ["p", "at"])).toBe("2024-01-02T03:04:05.000Z");
    expect(nested(ann, ["p", "err", "name"])).toBe("Error");
    expect(nested(ann, ["p", "err", "message"])).toBe("bad thing");
    expect(nested(ann, ["p", "url"])).toBe("https://example.test/path");
    expect(nested(ann, ["p", "big"])).toBe("10");
    expect(nested(ann, ["p", "set"])).toEqual([1, 2]);
    expect(nested(ann, ["p", "map"])).toEqual({ k: "v" });
  });

  test("bounds depth with a truncation marker", async () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 12; i += 1) deep = { d: deep };
    const ann = await logWith({ deep });
    const line = JSON.stringify(ann);
    expect(line).toContain("[truncated: depth]");
    expect(line).not.toContain("leaf");
  });

  test("bounds object keys, array length, and string length with markers", async () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 100; i += 1) wide[`k${i}`] = i;
    const ann = await logWith({
      wide: { inner: wide },
      long: { list: Array.from({ length: 300 }, (_, i) => i) },
      text: { s: "y".repeat(5000) },
    });
    const inner = nested(ann, ["wide", "inner"]) as Record<string, unknown>;
    expect(Object.keys(inner).length).toBe(65);
    expect(inner["…[truncated]"]).toBe(36);
    const list = nested(ann, ["long", "list"]) as ReadonlyArray<unknown>;
    expect(list.length).toBe(129);
    expect(list[128]).toBe("…[truncated: 172]");
    const s = nested(ann, ["text", "s"]) as string;
    expect(s.length).toBeLessThan(2100);
    expect(s).toContain("…[truncated]");
  });

  test("bounds the top-level annotation count with a marker", async () => {
    const many: Record<string, number> = {};
    for (let i = 0; i < 70; i += 1) many[`a${i}`] = i;
    const ann = await logWith(many);
    expect(Object.keys(ann).length).toBe(65);
    expect(ann["…[truncated]"]).toBe(6);
  });

  test("a cyclic object does not throw", async () => {
    const cyc: Record<string, unknown> = { name: "root" };
    cyc.self = cyc;
    cyc.list = [cyc];
    const ann = await logWith({ cyc });
    expect(nested(ann, ["cyc", "name"])).toBe("root");
    expect(nested(ann, ["cyc", "self"])).toBe("[circular]");
    expect(nested(ann, ["cyc", "list"])).toEqual(["[circular]"]);
  });

  test("redactKeys censors matching keys at any depth, case-insensitively", async () => {
    const ann = await logWith(
      {
        password: "top",
        req: { headers: { Authorization: "Bearer x", accept: "json" }, body: { token: "t" } },
        list: [{ apiKey: "k", ok: 1 }],
      },
      { redactKeys: ["password", "authorization", "token", "APIKEY"] },
    );
    expect(ann.password).toBe("[redacted]");
    expect(nested(ann, ["req", "headers", "Authorization"])).toBe("[redacted]");
    expect(nested(ann, ["req", "headers", "accept"])).toBe("json");
    expect(nested(ann, ["req", "body", "token"])).toBe("[redacted]");
    expect(nested(ann, ["list", "0", "apiKey"])).toBe("[redacted]");
    expect(nested(ann, ["list", "0", "ok"])).toBe(1);
  });

  test("structured message values are serialized into data and a readable event", async () => {
    const cap = captureLogger();
    await Effect.runPromise(
      Effect.log("request completed", { method: "GET", status: 200 }).pipe(
        Effect.provide(cap.layer),
      ),
    );
    const [record] = cap.records();
    expect(record?.event).toBe("request completed");
    expect(record?.data).toEqual({ method: "GET", status: 200 });

    const only = captureLogger();
    await Effect.runPromise(Effect.log({ boot: { port: 3000 } }).pipe(Effect.provide(only.layer)));
    const [rec] = only.records();
    expect(rec?.event).toBe('{"boot":{"port":3000}}');
    expect(rec?.data).toEqual({ boot: { port: 3000 } });
  });

  test("layerJson and layer accept redactKeys", async () => {
    const lines: Array<string> = [];
    await Effect.runPromise(
      Effect.log("x").pipe(
        Effect.annotateLogs({ auth: { Token: "t" } }),
        Effect.provide(
          layerJson((l) => lines.push(l), { redactKeys: ["token"] }).pipe(
            Layer.provide(ServiceMeta.layer(service)),
          ),
        ),
      ),
    );
    const [record] = lines.map((l) => JSON.parse(l) as LogRecord);
    expect(nested(record?.annotations ?? {}, ["auth", "Token"])).toBe("[redacted]");

    const original = globalThis.console.log;
    const captured: Array<string> = [];
    globalThis.console.log = (line: string) => {
      captured.push(line);
    };
    try {
      await Effect.runPromise(
        Effect.log("x").pipe(
          Effect.annotateLogs({ auth: { Token: "t" } }),
          Effect.provide(layer({ service, redactKeys: ["token"] })),
        ),
      );
    } finally {
      globalThis.console.log = original;
    }
    const [viaLayer] = captured.map((l) => JSON.parse(l) as LogRecord);
    expect(nested(viaLayer?.annotations ?? {}, ["auth", "Token"])).toBe("[redacted]");
  });
});

describe("correlation", () => {
  test("annotates logs and merges nested contexts", async () => {
    const cap = captureLogger();
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.log("inner");
        const ctx = yield* Correlation.current;
        expect(ctx.correlationId).toBe("corr-1");
        expect(ctx.requestId).toBe("req-2");
      }).pipe(
        Correlation.within({ requestId: "req-2" }),
        Correlation.within({ correlationId: "corr-1" }),
        Effect.provide(cap.layer),
      ),
    );
    const [record] = cap.records();
    expect(record?.annotations.correlationId).toBe("corr-1");
    expect(record?.annotations.requestId).toBe("req-2");
  });

  test("scoped generates a correlationId only when absent", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const ctx = yield* Correlation.current;
        expect(ctx.correlationId).toBeString();
        const inner = Effect.gen(function* () {
          const nested = yield* Correlation.current;
          expect(nested.correlationId).toBe(ctx.correlationId);
        });
        yield* Correlation.scoped()(inner);
      }).pipe(Correlation.scoped()),
    );
  });
});

describe("metrics", () => {
  test("track counts calls and errors", async () => {
    const metrics = Metrics.boundary("test_boundary");
    const program = Effect.gen(function* () {
      yield* Metrics.track("test_boundary", metrics)(Effect.succeed(1));
      yield* Metrics.track("test_boundary", metrics)(Effect.fail("nope")).pipe(Effect.ignore);
      const calls = yield* Metrics.counterValue(metrics.calls);
      const errors = yield* Metrics.counterValue(metrics.errors);
      expect(Number(calls)).toBe(2);
      expect(Number(errors)).toBe(1);
    });
    await Effect.runPromise(program);
  });
});

describe("layer", () => {
  test("composed layer provides ServiceMeta and logs at configured level", async () => {
    const obs = layer({ service, logLevel: LogLevel.Warning });
    await Effect.runPromise(
      Effect.gen(function* () {
        const meta = yield* ServiceMeta;
        expect(meta.name).toBe("svc");
      }).pipe(Effect.provide(obs)),
    );
  });
});

describe("one logger per process", () => {
  // What `BunRuntime.runMain` does before any app layer runs (unless told not to).
  const runMainPrettyLogger = Logger.replace(Logger.defaultLogger, Logger.prettyLoggerDefault);
  // Effect always keeps `tracerLogger` (log → span events) alongside the
  // printing logger; only the printing ones matter here.
  const installedLoggers = FiberRef.get(FiberRef.currentLoggers).pipe(
    Effect.map((loggers) =>
      HashSet.toValues(loggers).filter((logger) => logger !== Logger.tracerLogger),
    ),
  );

  test("layerJson replaces runMain's pretty logger too: one JSON line per record", async () => {
    const lines: Array<string> = [];
    const loggers = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.log("once");
        return yield* installedLoggers;
      }).pipe(
        Effect.provide(
          layerJson((line) => lines.push(line)).pipe(Layer.provide(ServiceMeta.layer(service))),
        ),
        Effect.provide(runMainPrettyLogger),
      ),
    );
    expect(lines).toHaveLength(1);
    expect(loggers).toHaveLength(1);
    expect(loggers).not.toContain(Logger.prettyLoggerDefault);
    expect(loggers).not.toContain(Logger.defaultLogger);
  });

  test("layerPretty on top of runMain's pretty logger still installs exactly one logger", async () => {
    const loggers = await Effect.runPromise(
      installedLoggers.pipe(Effect.provide(layerPretty), Effect.provide(runMainPrettyLogger)),
    );
    expect(loggers).toEqual([Logger.prettyLoggerDefault]);
  });
});
