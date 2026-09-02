import { describe, expect, test } from "bun:test";
import { Duration, Effect, Exit, Option, Redacted } from "effect";
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

  test("blank process environment values fall back to defaults", async () => {
    const key = "STRUCTURE_TEST_BLANK_PROCESS_ENV";
    const def = Settings.struct({ port: Settings.port(key, { default: 4321 }) });
    process.env[key] = "";
    try {
      const result = await Effect.runPromise(load(def));
      expect(result.port).toBe(4321);
    } finally {
      delete process.env[key];
    }
  });

  test("parses dotenv content", () => {
    const map = parseDotEnv('# comment\nexport FOO=bar\nQUOTED="a b"\nEMPTY=\nBAD LINE\n');
    expect(map.get("FOO")).toBe("bar");
    expect(map.get("QUOTED")).toBe("a b");
    expect(map.get("EMPTY")).toBe("");
    expect(map.has("BAD LINE")).toBe(false);
  });
});

describe("load from an injected environment map", () => {
  const withDefaults = Settings.struct({
    port: Settings.port("PORT", { default: 3000 }),
    name: Settings.optional(Settings.string("NAME")),
    http: Settings.nested(
      "HTTP",
      Settings.struct({ port: Settings.port("PORT", { default: 80 }) }),
    ),
  });

  test("reads values from `env` instead of the process environment", async () => {
    const key = "STRUCTURE_TEST_INJECTED_ENV";
    const def = Settings.struct({ port: Settings.port(key, { default: 1 }) });
    process.env[key] = "1111";
    try {
      const injected = await Effect.runPromise(load(def, { env: { [key]: "2222" } }));
      expect(injected.port).toBe(2222);
      const isolated = await Effect.runPromise(load(def, { env: {} }));
      expect(isolated.port).toBe(1);
    } finally {
      delete process.env[key];
    }
  });

  test("uses `_` as the nesting delimiter", async () => {
    const result = await Effect.runPromise(load(withDefaults, { env: { HTTP_PORT: "8081" } }));
    expect(result.http.port).toBe(8081);
    expect(result.port).toBe(3000);
  });

  test("blank values yield the default and `optional` loads None", async () => {
    const result = await Effect.runPromise(
      load(withDefaults, { env: { PORT: "", NAME: "   ", HTTP_PORT: "\t" } }),
    );
    expect(result.port).toBe(3000);
    expect(Option.isNone(result.name)).toBe(true);
    expect(result.http.port).toBe(80);
  });

  test("undefined entries are treated as unset", async () => {
    const result = await Effect.runPromise(load(withDefaults, { env: { PORT: undefined } }));
    expect(result.port).toBe(3000);
  });

  test("`blankMeansUnset: false` keeps blank values present", async () => {
    const result = await Effect.runPromise(
      load(withDefaults, { env: { NAME: "" }, blankMeansUnset: false }),
    );
    expect(Option.getOrNull(result.name)).toBe("");
    const exit = await Effect.runPromiseExit(
      load(withDefaults, { env: { PORT: "" }, blankMeansUnset: false }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(ConfigLoadError);
      expect(exit.cause.error.issues.map((i) => i.path)).toContain("PORT");
    }
  });

  test("precedence stays overrides → env → defaults", async () => {
    const result = await Effect.runPromise(
      load(withDefaults, { overrides: { PORT: "1" }, env: { PORT: "2", HTTP_PORT: "3" } }),
    );
    expect(result.port).toBe(1);
    expect(result.http.port).toBe(3);
  });
});
