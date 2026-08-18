import { describe, expect, test } from "bun:test";
import { Effect, Logger, LogLevel } from "effect";
import {
  Correlation,
  type LogRecord,
  layer,
  Metrics,
  makeJsonLogger,
  ServiceMeta,
} from "../src/index.js";

const service = { name: "svc", version: "1.2.3", instance: "i-1" };

const captureLogger = () => {
  const lines: Array<string> = [];
  const logger = makeJsonLogger(service, (line) => lines.push(line));
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
