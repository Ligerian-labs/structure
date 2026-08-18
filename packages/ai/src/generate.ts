import { type AiError, LanguageModel, Prompt, type Response } from "@effect/ai";
import { Metrics } from "@structure/observability";
import { Data, Duration, Effect, Metric, Schedule, type Schema, Stream } from "effect";

// =============================================================================
// Errors
// =============================================================================

/**
 * How a failed AI call should be treated by callers:
 * - `"transient"`: the failure is temporary (network transport, throttling,
 *   provider outage) and the call may be retried.
 * - `"permanent"`: retrying with the same input will fail again
 *   (bad request, auth, malformed output).
 */
export type AiErrorClassification = "transient" | "permanent";

/**
 * Provider-agnostic error for AI calls. Wraps the provider error as `cause`
 * so callers never need to match on provider internals.
 */
export class AiCallError extends Data.TaggedError("AiCallError")<{
  readonly message: string;
  readonly classification: AiErrorClassification;
  readonly timedOut: boolean;
  readonly cause: unknown;
}> {}

/**
 * Classifies a provider error: HTTP 408/429/5xx and transport failures are
 * transient; everything else (other 4xx, malformed input/output, unknown)
 * is permanent.
 */
export const classifyAiError = (error: AiError.AiError): AiErrorClassification => {
  switch (error._tag) {
    case "HttpRequestError":
      return error.reason === "Transport" ? "transient" : "permanent";
    case "HttpResponseError": {
      const status = error.response.status;
      return status === 408 || status === 429 || status >= 500 ? "transient" : "permanent";
    }
    case "MalformedInput":
    case "MalformedOutput":
    case "UnknownError":
      return "permanent";
  }
};

const fromAiError = (error: AiError.AiError): AiCallError => {
  const status = error._tag === "HttpResponseError" ? ` (status ${error.response.status})` : "";
  return new AiCallError({
    message: `AI call failed: ${error._tag}${status}`,
    classification: classifyAiError(error),
    timedOut: false,
    cause: error,
  });
};

// =============================================================================
// Observability
// =============================================================================

/** Traffic/error/latency signals for the `ai_generate` boundary. */
export const aiMetrics = Metrics.boundary("ai_generate");

/** Total input tokens consumed across all AI calls. */
export const inputTokensCounter = Metric.counter("ai_tokens_input_total", { incremental: true });

/** Total output tokens produced across all AI calls. */
export const outputTokensCounter = Metric.counter("ai_tokens_output_total", { incremental: true });

// =============================================================================
// Options & results
// =============================================================================

/** Defaults applied when the corresponding option is omitted. */
export const defaults = {
  timeout: Duration.seconds(60),
  maxRetries: 2,
  retryBaseDelay: Duration.millis(200),
} as const;

/**
 * Options shared by every generation call. Prompt bodies are never logged or
 * attached to spans; only bounded attributes (provider, model) are.
 */
export interface GenerateBaseOptions {
  /** The user prompt: plain text, messages, or an existing `Prompt`. */
  readonly prompt: Prompt.RawInput;
  /** Optional system message, replacing any system message in `prompt`. */
  readonly system?: string | undefined;
  /** Overall deadline for the call, retries included. Default 60 seconds. */
  readonly timeout?: Duration.DurationInput | undefined;
  /** Maximum retry attempts after the initial call. Default 2. */
  readonly maxRetries?: number | undefined;
  /** Base delay of the exponential backoff between retries. Default 200ms. */
  readonly retryBaseDelay?: Duration.DurationInput | undefined;
  /** Provider name recorded as a span attribute. */
  readonly provider?: string | undefined;
  /** Model identifier recorded as a span attribute. */
  readonly model?: string | undefined;
}

export interface GenerateObjectOptions<A, I extends Record<string, unknown>, R>
  extends GenerateBaseOptions {
  /** Schema the generated object must conform to. */
  readonly schema: Schema.Schema<A, I, R>;
  /** Name hint for the structured output, forwarded to the provider. */
  readonly objectName?: string | undefined;
}

/** Token counts for one call; missing provider data is reported as 0. */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface GenerateTextResult {
  readonly text: string;
  readonly usage: TokenUsage;
}

export interface GenerateObjectResult<A> {
  readonly value: A;
  readonly usage: TokenUsage;
}

// =============================================================================
// Internals
// =============================================================================

const toPrompt = (options: GenerateBaseOptions): Prompt.RawInput =>
  options.system === undefined
    ? options.prompt
    : Prompt.setSystem(Prompt.make(options.prompt), options.system);

const spanAttributes = (
  operation: string,
  options: GenerateBaseOptions,
): Record<string, string> => {
  const attributes: Record<string, string> = { "ai.operation": operation };
  if (options.provider !== undefined) attributes["ai.provider"] = options.provider;
  if (options.model !== undefined) attributes["ai.model"] = options.model;
  return attributes;
};

const summarizeUsage = (usage: Response.Usage): TokenUsage => ({
  inputTokens: usage.inputTokens ?? 0,
  outputTokens: usage.outputTokens ?? 0,
});

const recordUsage = (usage: TokenUsage): Effect.Effect<void> =>
  Effect.zipRight(
    Metric.incrementBy(inputTokensCounter, usage.inputTokens),
    Metric.incrementBy(outputTokensCounter, usage.outputTokens),
  );

/**
 * Applies the production call contract around a raw model interaction:
 * error classification, bounded retry with backoff and jitter on transient
 * failures only, an overall timeout, boundary metrics, and a span carrying
 * bounded attributes (never prompt bodies).
 */
const instrument = (operation: string, options: GenerateBaseOptions) => {
  const timeout = Duration.decode(options.timeout ?? defaults.timeout);
  return <A, R>(effect: Effect.Effect<A, AiError.AiError, R>): Effect.Effect<A, AiCallError, R> =>
    effect.pipe(
      Effect.mapError(fromAiError),
      Effect.retry({
        schedule: Schedule.jittered(
          Schedule.exponential(options.retryBaseDelay ?? defaults.retryBaseDelay, 2),
        ),
        while: (error: AiCallError) => error.classification === "transient",
        times: options.maxRetries ?? defaults.maxRetries,
      }),
      Effect.timeoutFail({
        duration: timeout,
        onTimeout: () =>
          new AiCallError({
            message: `AI call timed out after ${Duration.format(timeout)}`,
            classification: "transient",
            timedOut: true,
            cause: undefined,
          }),
      }),
      Metrics.track("ai_generate", aiMetrics),
      Effect.withSpan("ai.generate", { attributes: spanAttributes(operation, options) }),
    );
};

// =============================================================================
// Calls
// =============================================================================

/** Generates text, returning the full response text and token usage. */
export const generateText = (
  options: GenerateBaseOptions,
): Effect.Effect<GenerateTextResult, AiCallError, LanguageModel.LanguageModel> =>
  Effect.gen(function* () {
    const response = yield* LanguageModel.generateText({ prompt: toPrompt(options) });
    const usage = summarizeUsage(response.usage);
    yield* recordUsage(usage);
    return { text: response.text, usage };
  }).pipe(instrument("generateText", options));

/**
 * Generates a structured object validated against `schema`. A response that
 * does not conform fails with a permanent `AiCallError` (never a defect).
 */
export const generateObject = <A, I extends Record<string, unknown>, R>(
  options: GenerateObjectOptions<A, I, R>,
): Effect.Effect<GenerateObjectResult<A>, AiCallError, LanguageModel.LanguageModel | R> =>
  Effect.gen(function* () {
    const response = yield* LanguageModel.generateObject({
      prompt: toPrompt(options),
      schema: options.schema,
      objectName: options.objectName,
    });
    const usage = summarizeUsage(response.usage);
    yield* recordUsage(usage);
    return { value: response.value, usage };
  }).pipe(instrument("generateObject", options));

/** A stream part produced by a call that uses no tools. */
export type TextStreamPart = Response.StreamPart<Record<string, never>>;

/**
 * Streams response parts as they arrive. Errors are classified into
 * `AiCallError`, but no retry or timeout is applied: replaying a partially
 * consumed stream is not safe, so resilience is left to the caller.
 */
export const streamText = (
  options: GenerateBaseOptions,
): Stream.Stream<TextStreamPart, AiCallError, LanguageModel.LanguageModel> =>
  LanguageModel.streamText({ prompt: toPrompt(options) }).pipe(
    Stream.mapError(fromAiError),
    Stream.withSpan("ai.stream", { attributes: spanAttributes("streamText", options) }),
  );
