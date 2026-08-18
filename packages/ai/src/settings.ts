import { type Setting, Settings } from "@structure-ai/config";
import { Duration } from "effect";

/**
 * Standard LLM settings. Nest under a prefix if the host app needs to:
 * `Settings.nested("APP", aiSettings)`.
 */
export const aiSettings = Settings.struct({
  provider: Settings.literal("AI_PROVIDER", ["anthropic", "openai"], {
    description: "LLM provider to route calls through",
    default: "anthropic",
  }),
  model: Settings.string("AI_MODEL", {
    description: "model identifier passed to the provider",
    default: "claude-sonnet-4-5",
  }),
  apiKey: Settings.secret("AI_API_KEY", {
    description: "provider API key; kept redacted everywhere",
  }),
  baseUrl: Settings.optional(
    Settings.string("AI_BASE_URL", {
      description: "override for the provider API base URL (proxy, mock, gateway)",
    }),
  ),
  timeout: Settings.duration("AI_TIMEOUT", {
    description: "overall deadline for one AI call, retries included",
    default: Duration.seconds(60),
  }),
  maxRetries: Settings.int("AI_MAX_RETRIES", {
    description: "maximum retry attempts after the initial call, transient failures only",
    default: 2,
  }),
});

/** The loaded, typed value of {@link aiSettings}. */
export type AiSettings = typeof aiSettings extends Setting<infer A> ? A : never;
