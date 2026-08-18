import type { LanguageModel } from "@effect/ai";
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import { FetchHttpClient } from "@effect/platform";
import { Layer, Option, type Redacted } from "effect";
import type { AiSettings } from "./settings.js";

/** Provider-agnostic connection configuration for a language model layer. */
export interface ProviderConfig {
  readonly apiKey: Redacted.Redacted<string>;
  readonly model: string;
  readonly baseUrl?: string | undefined;
}

/**
 * A self-contained `LanguageModel` layer backed by Anthropic's API.
 * Includes the provider client and an HTTP client, so it requires nothing.
 */
export const layerAnthropic = (config: ProviderConfig): Layer.Layer<LanguageModel.LanguageModel> =>
  AnthropicLanguageModel.layer({ model: config.model }).pipe(
    Layer.provide(AnthropicClient.layer({ apiKey: config.apiKey, apiUrl: config.baseUrl })),
    Layer.provide(FetchHttpClient.layer),
  );

/**
 * A self-contained `LanguageModel` layer backed by OpenAI's API.
 * Includes the provider client and an HTTP client, so it requires nothing.
 */
export const layerOpenAi = (config: ProviderConfig): Layer.Layer<LanguageModel.LanguageModel> =>
  OpenAiLanguageModel.layer({ model: config.model }).pipe(
    Layer.provide(OpenAiClient.layer({ apiKey: config.apiKey, apiUrl: config.baseUrl })),
    Layer.provide(FetchHttpClient.layer),
  );

/** Builds the `LanguageModel` layer selected by loaded {@link AiSettings}. */
export const layerFromSettings = (
  settings: AiSettings,
): Layer.Layer<LanguageModel.LanguageModel> => {
  const config: ProviderConfig = {
    apiKey: settings.apiKey,
    model: settings.model,
    baseUrl: Option.getOrUndefined(settings.baseUrl),
  };
  switch (settings.provider) {
    case "anthropic":
      return layerAnthropic(config);
    case "openai":
      return layerOpenAi(config);
  }
};
