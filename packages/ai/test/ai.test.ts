import { describe, expect, test } from "bun:test";
import { AiError } from "@effect/ai";
import { Metrics } from "@structure-ai/observability";
import { Chunk, Effect, Option, Schema, Stream } from "effect";
import {
  classifyAiError,
  generateObject,
  generateText,
  inputTokensCounter,
  outputTokensCounter,
  streamText,
  TestModel,
} from "../src/index.js";

const request = {
  method: "POST",
  url: "https://example.invalid/v1/messages",
  urlParams: [],
  hash: Option.none(),
  headers: {},
} as const;

const statusError = (status: number) =>
  new AiError.HttpResponseError({
    module: "test",
    method: "generateText",
    reason: "StatusCode",
    request,
    response: { status, headers: {} },
  });

const transportError = () =>
  new AiError.HttpRequestError({
    module: "test",
    method: "generateText",
    reason: "Transport",
    request,
  });

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

describe("generateText", () => {
  test("returns scripted text with usage and increments token counters", async () => {
    const model = TestModel.scripted(["scripted answer"], {
      usage: { inputTokens: 11, outputTokens: 7 },
    });
    const result = await run(
      Effect.gen(function* () {
        const inputBefore = yield* Metrics.counterValue(inputTokensCounter);
        const outputBefore = yield* Metrics.counterValue(outputTokensCounter);
        const result = yield* generateText({ prompt: "hello", system: "be terse" });
        const inputAfter = yield* Metrics.counterValue(inputTokensCounter);
        const outputAfter = yield* Metrics.counterValue(outputTokensCounter);
        return {
          result,
          inputDelta: Number(inputAfter) - Number(inputBefore),
          outputDelta: Number(outputAfter) - Number(outputBefore),
        };
      }).pipe(Effect.provide(model.layer)),
    );
    expect(result.result.text).toBe("scripted answer");
    expect(result.result.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    expect(result.inputDelta).toBe(11);
    expect(result.outputDelta).toBe(7);
    expect(model.calls()).toBe(1);
  });

  test("exhausted script fails with a typed permanent error", async () => {
    const model = TestModel.scripted([]);
    const error = await run(
      Effect.flip(generateText({ prompt: "hello" }).pipe(Effect.provide(model.layer))),
    );
    expect(error._tag).toBe("AiCallError");
    expect(error.classification).toBe("permanent");
  });
});

describe("generateObject", () => {
  const Contact = Schema.Struct({ name: Schema.String, age: Schema.Number });

  test("decodes a scripted object against the schema", async () => {
    const model = TestModel.scripted([{ name: "Ada", age: 36 }]);
    const result = await run(
      generateObject({ prompt: "extract", schema: Contact }).pipe(Effect.provide(model.layer)),
    );
    expect(result.value).toEqual({ name: "Ada", age: 36 });
    expect(result.usage).toEqual({ inputTokens: 17, outputTokens: 5 });
  });

  test("schema mismatch is a typed permanent failure, not a defect", async () => {
    const model = TestModel.scripted([{ name: "Ada", age: "not a number" }]);
    const error = await run(
      Effect.flip(
        generateObject({ prompt: "extract", schema: Contact }).pipe(Effect.provide(model.layer)),
      ),
    );
    expect(error._tag).toBe("AiCallError");
    expect(error.classification).toBe("permanent");
    expect(AiError.isAiError(error.cause)).toBe(true);
    expect((error.cause as AiError.AiError)._tag).toBe("MalformedOutput");
  });
});

describe("retry", () => {
  test("retries transient failures with backoff and succeeds", async () => {
    const model = TestModel.scripted([statusError(429), statusError(503), "recovered"]);
    const result = await run(
      generateText({ prompt: "hello", maxRetries: 2, retryBaseDelay: "1 millis" }).pipe(
        Effect.provide(model.layer),
      ),
    );
    expect(result.text).toBe("recovered");
    expect(model.calls()).toBe(3);
  });

  test("does not retry permanent failures", async () => {
    const model = TestModel.scripted([statusError(400), "never reached"]);
    const error = await run(
      Effect.flip(
        generateText({ prompt: "hello", maxRetries: 2, retryBaseDelay: "1 millis" }).pipe(
          Effect.provide(model.layer),
        ),
      ),
    );
    expect(error.classification).toBe("permanent");
    expect(model.calls()).toBe(1);
  });

  test("stops after maxRetries attempts", async () => {
    const model = TestModel.scripted([
      statusError(429),
      statusError(429),
      statusError(429),
      "never reached",
    ]);
    const error = await run(
      Effect.flip(
        generateText({ prompt: "hello", maxRetries: 2, retryBaseDelay: "1 millis" }).pipe(
          Effect.provide(model.layer),
        ),
      ),
    );
    expect(error.classification).toBe("transient");
    expect(model.calls()).toBe(3);
  });
});

describe("timeout", () => {
  test("produces a typed timeout error", async () => {
    const model = TestModel.scripted(["too late"], { delay: "5 seconds" });
    const error = await run(
      Effect.flip(
        generateText({ prompt: "hello", timeout: "20 millis" }).pipe(Effect.provide(model.layer)),
      ),
    );
    expect(error._tag).toBe("AiCallError");
    expect(error.timedOut).toBe(true);
    expect(error.message).toContain("timed out");
  });
});

describe("classifyAiError", () => {
  test("throttle and server statuses are transient", () => {
    expect(classifyAiError(statusError(408))).toBe("transient");
    expect(classifyAiError(statusError(429))).toBe("transient");
    expect(classifyAiError(statusError(500))).toBe("transient");
    expect(classifyAiError(statusError(529))).toBe("transient");
  });

  test("other client statuses are permanent", () => {
    expect(classifyAiError(statusError(400))).toBe("permanent");
    expect(classifyAiError(statusError(401))).toBe("permanent");
    expect(classifyAiError(statusError(404))).toBe("permanent");
  });

  test("transport failures are transient, encoding failures are not", () => {
    expect(classifyAiError(transportError())).toBe("transient");
    expect(
      classifyAiError(
        new AiError.HttpRequestError({
          module: "test",
          method: "generateText",
          reason: "Encode",
          request,
        }),
      ),
    ).toBe("permanent");
  });

  test("malformed and unknown errors are permanent", () => {
    expect(
      classifyAiError(new AiError.MalformedOutput({ module: "test", method: "generateObject" })),
    ).toBe("permanent");
    expect(
      classifyAiError(new AiError.MalformedInput({ module: "test", method: "generateText" })),
    ).toBe("permanent");
    expect(
      classifyAiError(new AiError.UnknownError({ module: "test", method: "generateText" })),
    ).toBe("permanent");
  });
});

describe("streamText", () => {
  test("streams scripted text as deltas", async () => {
    const model = TestModel.scripted(["streamed text"]);
    const parts = await Effect.runPromise(
      Stream.runCollect(streamText({ prompt: "hello" })).pipe(
        Effect.scoped,
        Effect.provide(model.layer),
      ),
    );
    const text = Chunk.toReadonlyArray(parts)
      .filter((part) => part.type === "text-delta")
      .map((part) => part.delta)
      .join("");
    expect(text).toBe("streamed text");
  });

  test("stream failures are classified AiCallErrors", async () => {
    const model = TestModel.scripted([statusError(429)]);
    const error = await Effect.runPromise(
      Effect.flip(
        Stream.runCollect(streamText({ prompt: "hello" })).pipe(
          Effect.scoped,
          Effect.provide(model.layer),
        ),
      ),
    );
    expect(error._tag).toBe("AiCallError");
    expect(error.classification).toBe("transient");
  });
});
