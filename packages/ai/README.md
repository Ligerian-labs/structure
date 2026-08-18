# @structure/ai

Provider-agnostic LLM bindings on `@effect/ai` for agentic apps: typed calls with structured output, per-call deadlines, bounded retries on transient failures only, token metrics — and a deterministic scripted model so nothing in your tests touches the network. API keys stay `Redacted`; prompt bodies never land in logs or spans.

## Usage

```ts
import { aiSettings, generateObject, generateText, layerFromSettings, TestModel } from "@structure/ai";
import { load } from "@structure/config";
import { Effect, Schema } from "effect";

const program = Effect.gen(function* () {
  const settings = yield* load(aiSettings);          // AI_PROVIDER, AI_MODEL, AI_API_KEY, ...
  const text = yield* generateText({ prompt: "Summarize the incident." });
  const triage = yield* generateObject({
    prompt: "Classify this ticket.",
    schema: Schema.Struct({ severity: Schema.Literal("low", "high"), reason: Schema.String }),
  });
});
// production: Effect.provide(program, layerFromSettings(settings))
// tests:      Effect.provide(program, TestModel.scripted(["a summary", { severity: "low", reason: "..." }]).layer)
```

## Exports

| Export | What it is |
| --- | --- |
| `aiSettings` | `@structure/config` settings: provider (anthropic\|openai), model, `AI_API_KEY` secret, base URL, timeout (60s), max retries (2). |
| `layerAnthropic` / `layerOpenAi` / `layerFromSettings` | `LanguageModel` layers (HTTP via fetch; no SDKs). |
| `generateText(opts)` | `Effect<{ text, usage: { inputTokens, outputTokens } }, AiCallError, LanguageModel>`. |
| `generateObject({ schema, ... })` | Structured output decoded against your Schema; malformed output is a typed failure, not a defect. |
| `streamText(opts)` | Streaming passthrough (classified errors + span; no retry — replaying a partly-consumed stream is unsafe). |
| `AiCallError` / `classifyAiError` | Provider-agnostic error with `classification`; transport + HTTP 408/429/5xx → `transient`, other 4xx and malformed IO → `permanent`. Only transient failures are retried (exponential backoff + jitter). |
| `TestModel.scripted(responses, opts?)` | Deterministic model layer returning scripted responses (strings, objects, or `AiError`s) with fake usage; exposes `calls()` for attempt-count assertions. |

Every call runs in an `ai.generate` span (provider/model attributes only) with `ai_generate` boundary metrics and `ai_tokens_input_total` / `ai_tokens_output_total` counters.
