import { AiError, LanguageModel, type Response } from "@effect/ai";
import { type Duration, Effect, Layer, Stream } from "effect";

/**
 * One scripted turn: text is returned verbatim, a plain object is returned as
 * its JSON encoding (so `generateObject` can decode it), and an `AiError`
 * makes that call fail with exactly that error.
 */
export type ScriptedResponse = string | Record<string, unknown> | AiError.AiError;

export interface FakeUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ScriptedOptions {
  /** Usage reported for every successful call. Defaults to 17 in / 5 out. */
  readonly usage?: FakeUsage | undefined;
  /** Artificial latency before each response — for timeout tests. */
  readonly delay?: Duration.DurationInput | undefined;
}

export interface ScriptedModel {
  /** Provides the scripted model as the `LanguageModel` service. */
  readonly layer: Layer.Layer<LanguageModel.LanguageModel>;
  /** Number of model invocations so far (retries included). */
  readonly calls: () => number;
}

const defaultUsage: FakeUsage = { inputTokens: 17, outputTokens: 5 };

const encodeUsage = (usage: FakeUsage) => ({
  inputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
  totalTokens: usage.inputTokens + usage.outputTokens,
});

/**
 * A deterministic in-memory `LanguageModel` that replays the given responses
 * in order. Calls past the end of the script fail with an `UnknownError`.
 * No network access — this is what this package's own tests run against.
 */
export const scripted = (
  responses: ReadonlyArray<ScriptedResponse>,
  options?: ScriptedOptions,
): ScriptedModel => {
  const usage = options?.usage ?? defaultUsage;
  const state = { calls: 0 };

  const nextText: Effect.Effect<string, AiError.AiError> = Effect.suspend(() => {
    const entry = responses[state.calls];
    state.calls += 1;
    if (entry === undefined) {
      return Effect.fail(
        new AiError.UnknownError({
          module: "TestModel",
          method: "generateText",
          description: `script exhausted after ${responses.length} response(s)`,
        }),
      );
    }
    if (AiError.isAiError(entry)) return Effect.fail(entry);
    return Effect.succeed(typeof entry === "string" ? entry : JSON.stringify(entry));
  }).pipe(options?.delay === undefined ? (self) => self : Effect.delay(options.delay));

  const generateText = Effect.map(
    nextText,
    (text): Array<Response.PartEncoded> => [
      { type: "text", text },
      { type: "finish", reason: "stop", usage: encodeUsage(usage) },
    ],
  );

  const streamText = Stream.unwrap(
    Effect.map(nextText, (text) =>
      Stream.fromIterable<Response.StreamPartEncoded>([
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", delta: text },
        { type: "text-end", id: "text-1" },
        { type: "finish", reason: "stop", usage: encodeUsage(usage) },
      ]),
    ),
  );

  return {
    layer: Layer.effect(
      LanguageModel.LanguageModel,
      LanguageModel.make({
        generateText: () => generateText,
        streamText: () => streamText,
      }),
    ),
    calls: () => state.calls,
  };
};

/** Shorthand for {@link scripted} when call counting is not needed. */
export const layer = (
  responses: ReadonlyArray<ScriptedResponse>,
  options?: ScriptedOptions,
): Layer.Layer<LanguageModel.LanguageModel> => scripted(responses, options).layer;
