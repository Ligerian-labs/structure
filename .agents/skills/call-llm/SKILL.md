---
name: call-llm
description: Make LLM calls with structured output, retries, and a deterministic test model in a @structure-based app. Use when adding any AI/LLM feature.
---

# Call an LLM

Provider-agnostic bindings on `@effect/ai`: typed calls, structured output decoded against a Schema, bounded retries on transient failures only, token metrics — and a scripted `TestModel` so tests never touch the network. Reference: `packages/ai/README.md`.

## Steps

1. **Configure from settings** — `aiSettings` (`AI_PROVIDER`, `AI_MODEL`, `AI_API_KEY` secret, base URL, timeout, max retries) via `@structure-ai/config`; build the layer with `layerFromSettings(settings)` (or `layerAnthropic`/`layerOpenAi` directly).

```ts
import { generateObject, generateText } from "@structure-ai/ai";
import { Schema } from "effect";

const text = yield* generateText({ prompt: "Summarize the incident." });
const triage = yield* generateObject({
  prompt: "Classify this ticket.",
  schema: Schema.Struct({ severity: Schema.Literal("low", "high"), reason: Schema.String }),
});
```

2. **Prefer `generateObject`** whenever the result feeds code — the model's output is decoded against your Schema; malformed output is a typed failure, not a defect.
3. **Let the layer classify and retry**: transport failures and HTTP 408/429/5xx are `transient` (exponential backoff + jitter, bounded by max retries); other 4xx and malformed IO are `permanent` and fail fast. Don't add your own retry loops.
4. **`streamText` for streaming** — classified errors + span, but no retry (replaying a partly-consumed stream is unsafe); handle reconnects at the caller.
5. **Tests:** provide `TestModel.scripted(["a summary", { severity: "low", reason: "..." }]).layer` and assert behavior — including attempt counts via `calls()` for retry paths. Follow `packages/ai/test/`.

## Rules

- API keys are `Redacted` from config to the provider call; prompt bodies never land in logs or spans (spans carry provider/model attributes only).
- Prompts are code: review them in PRs like code; don't assemble them from unvalidated user input.
- Bound every call (default deadline 60s) — an LLM call is a network dependency like any other.
- Errors surface as `AiCallError` with `classification`; map `transient` to user-facing "try again" and `permanent` to a specific fix, never a raw stack.

## Verify

`bun x tsc --noEmit && bun test` in the package.
