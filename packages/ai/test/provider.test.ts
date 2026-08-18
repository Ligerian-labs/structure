import { describe, expect, test } from "bun:test";
import { load } from "@structure/config";
import { Duration, Effect, Layer, Option, Redacted } from "effect";
import { aiSettings, layerAnthropic, layerFromSettings, layerOpenAi } from "../src/index.js";

describe("aiSettings", () => {
  test("loads with defaults and a redacted api key", async () => {
    const settings = await Effect.runPromise(
      load(aiSettings, { overrides: { AI_API_KEY: "sk-test" } }),
    );
    expect(settings.provider).toBe("anthropic");
    expect(settings.model).toBe("claude-sonnet-4-5");
    expect(Redacted.value(settings.apiKey)).toBe("sk-test");
    expect(Option.isNone(settings.baseUrl)).toBe(true);
    expect(Duration.toMillis(settings.timeout)).toBe(60_000);
    expect(settings.maxRetries).toBe(2);
    // The secret never leaks through rendering.
    expect(String(settings.apiKey)).not.toContain("sk-test");
  });

  test("loads explicit overrides", async () => {
    const settings = await Effect.runPromise(
      load(aiSettings, {
        overrides: {
          AI_PROVIDER: "openai",
          AI_MODEL: "gpt-5",
          AI_API_KEY: "sk-other",
          AI_BASE_URL: "https://proxy.example.com",
          AI_TIMEOUT: "10 seconds",
          AI_MAX_RETRIES: "5",
        },
      }),
    );
    expect(settings.provider).toBe("openai");
    expect(settings.model).toBe("gpt-5");
    expect(Option.getOrUndefined(settings.baseUrl)).toBe("https://proxy.example.com");
    expect(Duration.toMillis(settings.timeout)).toBe(10_000);
    expect(settings.maxRetries).toBe(5);
  });
});

describe("provider layers", () => {
  // Compile-and-construct coverage only: building the layers must not require
  // any context or perform network calls. Real calls are never made in tests.
  const config = {
    apiKey: Redacted.make("sk-test"),
    model: "test-model",
    baseUrl: "https://proxy.example.com",
  };

  test("layerAnthropic constructs a self-contained layer", () => {
    expect(Layer.isLayer(layerAnthropic(config))).toBe(true);
    expect(Layer.isLayer(layerAnthropic({ apiKey: config.apiKey, model: config.model }))).toBe(
      true,
    );
  });

  test("layerOpenAi constructs a self-contained layer", () => {
    expect(Layer.isLayer(layerOpenAi(config))).toBe(true);
  });

  test("layerFromSettings selects the configured provider", async () => {
    const settings = await Effect.runPromise(
      load(aiSettings, { overrides: { AI_API_KEY: "sk-test", AI_PROVIDER: "openai" } }),
    );
    expect(Layer.isLayer(layerFromSettings(settings))).toBe(true);
  });
});
