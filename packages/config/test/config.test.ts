import { describe, expect, test } from "bun:test";
import { Duration, Effect, Exit, Redacted } from "effect";
import { ConfigLoadError, load, parseDotEnv, Settings } from "../src/index.js";

const definition = Settings.struct({
  host: Settings.string("HOST", { description: "bind host", default: "0.0.0.0" }),
  port: Settings.port("PORT", { description: "listen port" }),
  timeout: Settings.duration("TIMEOUT", { default: Duration.seconds(5) }),
  apiKey: Settings.secret("API_KEY"),
  logFormat: Settings.literal("LOG_FORMAT", ["json", "pretty"], { default: "json" }),
});

describe("Settings + load", () => {
  test("loads from overrides with defaults applied", async () => {
    const result = await Effect.runPromise(
      load(definition, { overrides: { PORT: "8080", API_KEY: "s3cret" } }),
    );
    expect(result.host).toBe("0.0.0.0");
    expect(result.port).toBe(8080);
    expect(result.logFormat).toBe("json");
    expect(Redacted.value(result.apiKey)).toBe("s3cret");
    expect(Duration.toMillis(result.timeout)).toBe(5000);
  });

  test("overrides take precedence over environment", async () => {
    const key = "STRUCTURE_TEST_PORT_PRECEDENCE";
    const def = Settings.struct({ port: Settings.port(key) });
    process.env[key] = "1111";
    try {
      const viaEnv = await Effect.runPromise(load(def));
      expect(viaEnv.port).toBe(1111);
      const viaOverride = await Effect.runPromise(load(def, { overrides: { [key]: "2222" } }));
      expect(viaOverride.port).toBe(2222);
    } finally {
      delete process.env[key];
    }
  });

  test("accumulates all issues instead of failing on the first", async () => {
    const exit = await Effect.runPromiseExit(load(definition, { overrides: {} }));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      const error = exit.cause.error;
      expect(error).toBeInstanceOf(ConfigLoadError);
      const paths = error.issues.map((i) => i.path);
      expect(paths).toContain("PORT");
      expect(paths).toContain("API_KEY");
      expect(error.message).toContain("2 issues");
    }
  });

  test("rejects invalid port values", async () => {
    const exit = await Effect.runPromiseExit(
      load(definition, { overrides: { PORT: "70000", API_KEY: "x" } }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("nested prefixes env names", async () => {
    const def = Settings.nested("HTTP", Settings.struct({ port: Settings.port("PORT") }));
    const result = await Effect.runPromise(load(def, { overrides: { HTTP_PORT: "9090" } }));
    expect(result.port).toBe(9090);
    expect(def.docs[0]?.name).toBe("HTTP_PORT");
  });

  test("renders docs as a markdown table with secrets flagged", () => {
    const table = Settings.renderDocs(definition);
    expect(table).toContain("| PORT | port | yes |");
    expect(table).toContain("| API_KEY | secret | yes |");
    expect(table).toContain("| HOST | string | no | 0.0.0.0 |");
  });

  test("parses dotenv content", () => {
    const map = parseDotEnv('# comment\nexport FOO=bar\nQUOTED="a b"\nEMPTY=\nBAD LINE\n');
    expect(map.get("FOO")).toBe("bar");
    expect(map.get("QUOTED")).toBe("a b");
    expect(map.get("EMPTY")).toBe("");
    expect(map.has("BAD LINE")).toBe(false);
  });
});
