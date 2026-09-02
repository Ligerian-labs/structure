import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load as loadSettings, Settings } from "@structure-ai/config";
import { Config, Effect, Exit, Layer } from "effect";
import {
  apply,
  cascade,
  check,
  configProvider,
  DotenvError,
  environment,
  layer,
  load,
  setValues,
  toConfigIssues,
  unsetKeys,
} from "../src/index.js";

let cwd = "";

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), "structure-dotenv-"));
  await writeFile(
    join(cwd, ".env"),
    "BASE=env\nSHARED=env\nURL=http://$HOST:$PORT\nHOST=localhost\nPORT=3000\nSECRET=s3cret\n",
  );
  await writeFile(join(cwd, ".env.local"), "SHARED=local\nLOCAL_ONLY=1\n");
  await writeFile(join(cwd, ".env.development"), "PORT=4000\nDEV=1\n");
  await writeFile(join(cwd, ".env.development.local"), "DEV=local\n");
  await writeFile(join(cwd, ".env.test"), "TEST_ONLY=1\n");
  await writeFile(join(cwd, ".env.example"), "BASE=\nSECRET=\nMISSING_IN_FILES=\n");
});

afterAll(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("cascade", () => {
  test("file order per environment", () => {
    expect(cascade("development")).toEqual([
      ".env",
      ".env.local",
      ".env.development",
      ".env.development.local",
    ]);
    expect(cascade("test")).toEqual([".env", ".env.test", ".env.test.local"]);
    expect(cascade("")).toEqual([".env", ".env.local"]);
  });
});

describe("load", () => {
  test("later files in the cascade win and missing ones are skipped", async () => {
    const loaded = await Effect.runPromise(load({ cwd, environment: "development", env: {} }));
    expect(loaded.values.get("SHARED")).toBe("local");
    expect(loaded.values.get("PORT")).toBe("4000");
    expect(loaded.values.get("DEV")).toBe("local");
    expect(loaded.values.get("URL")).toBe("http://localhost:4000");
    expect(loaded.files.map((f) => f.slice(cwd.length + 1))).toEqual([
      ".env",
      ".env.local",
      ".env.development",
      ".env.development.local",
    ]);
    expect(loaded.sources.get("PORT")?.endsWith(".env.development")).toBe(true);
    expect(loaded.shadowed).toEqual([]);
  });

  test("the test environment skips .env.local", async () => {
    const loaded = await Effect.runPromise(load({ cwd, environment: "test", env: {} }));
    expect(loaded.values.get("SHARED")).toBe("env");
    expect(loaded.values.has("LOCAL_ONLY")).toBe(false);
    expect(loaded.values.get("TEST_ONLY")).toBe("1");
  });

  test("the environment name defaults to NODE_ENV of the given env", async () => {
    const loaded = await Effect.runPromise(load({ cwd, env: { NODE_ENV: "development" } }));
    expect(loaded.values.get("DEV")).toBe("local");
  });

  test("environment variables win unless override is set, and are reported as shadowed", async () => {
    const env = { PORT: "9999" };
    const kept = await Effect.runPromise(load({ cwd, environment: "", env }));
    expect(kept.values.has("PORT")).toBe(false);
    expect(kept.shadowed).toEqual(["PORT"]);
    expect(kept.values.get("URL")).toBe("http://localhost:9999");
    const overridden = await Effect.runPromise(load({ cwd, environment: "", env, override: true }));
    expect(overridden.values.get("PORT")).toBe("3000");
    expect(overridden.values.get("URL")).toBe("http://localhost:3000");
    expect(overridden.shadowed).toEqual([]);
  });

  test("explicit files must exist", async () => {
    const exit = await Effect.runPromiseExit(load({ cwd, files: [".env", ".env.nope"], env: {} }));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(DotenvError);
      expect(exit.cause.error.kind).toBe("missing");
      expect(exit.cause.error.message).toContain(".env.nope");
      expect(exit.cause.error.message).not.toContain("s3cret");
    }
  });

  test("expand: false keeps references literal", async () => {
    const loaded = await Effect.runPromise(load({ cwd, environment: "", env: {}, expand: false }));
    expect(loaded.values.get("URL")).toBe("http://$HOST:$PORT");
  });
});

describe("integration with config and Effect Config", () => {
  test("environment() feeds @structure-ai/config load without touching process.env", async () => {
    const settings = Settings.struct({
      port: Settings.port("PORT"),
      secret: Settings.secret("SECRET"),
      http: Settings.nested("HTTP", Settings.struct({ host: Settings.string("HOST") })),
    });
    const env = await Effect.runPromise(
      environment({ cwd, files: [".env"], env: { HTTP_HOST: "0.0.0.0" } }),
    );
    const config = await Effect.runPromise(loadSettings(settings, { env }));
    expect(config.port).toBe(3000);
    expect(config.http.host).toBe("0.0.0.0");
    expect(process.env.SECRET).toBeUndefined();
  });

  test("configProvider() serves Effect Config with _ nesting", async () => {
    const provider = await Effect.runPromise(configProvider({ cwd, files: [".env"], env: {} }));
    const program = Effect.all({
      port: Config.integer("PORT"),
      host: Config.nested(Config.string("HOST"), "X"),
    }).pipe(Effect.withConfigProvider(provider), Effect.exit);
    const nested = await Effect.runPromise(
      Effect.withConfigProvider(
        Config.nested(Config.string("HOST"), "X"),
        await Effect.runPromise(configProvider({ cwd, files: [".env"], env: { X_HOST: "n" } })),
      ),
    );
    expect(nested).toBe("n");
    expect(Exit.isFailure(await Effect.runPromise(program))).toBe(true);
  });

  test("apply() and layer() write into process.env, without overriding what is set", async () => {
    const key = "STRUCTURE_DOTENV_APPLY_TEST";
    const kept = "STRUCTURE_DOTENV_KEPT_TEST";
    const dir = await mkdtemp(join(tmpdir(), "structure-dotenv-apply-"));
    await writeFile(join(dir, ".env"), `${key}=applied\n${kept}=from-file\n`);
    process.env[kept] = "from-env";
    try {
      const loaded = await Effect.runPromise(apply({ cwd: dir, environment: "" }));
      expect(process.env[key]).toBe("applied");
      expect(process.env[kept]).toBe("from-env");
      expect(loaded.shadowed).toEqual([kept]);
      delete process.env[key];
      await Effect.runPromise(
        Effect.sync(() => process.env[key]).pipe(
          Effect.provide(layer({ cwd: dir, environment: "" })),
          Effect.tap((value) => Effect.sync(() => expect(value).toBe("applied"))),
        ),
      );
      await Effect.runPromise(
        Effect.provide(Effect.void, Layer.merge(layer({ cwd: dir, environment: "" }), Layer.empty)),
      );
    } finally {
      delete process.env[key];
      delete process.env[kept];
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("check", () => {
  const settings = Settings.struct({
    base: Settings.string("BASE"),
    secret: Settings.secret("SECRET"),
    optional: Settings.optional(Settings.string("OPTIONAL_THING")),
    defaulted: Settings.int("DEFAULTED", { default: 1 }),
    required: Settings.string("REQUIRED_BUT_MISSING"),
  });

  test("against a settings definition", async () => {
    const report = await Effect.runPromise(
      check({ cwd, files: [".env"], env: { DEFAULTED: "" }, settings }),
    );
    expect(report.required).toEqual(["BASE", "SECRET", "REQUIRED_BUT_MISSING"]);
    expect(report.missing).toEqual(["REQUIRED_BUT_MISSING"]);
    expect(report.empty).toEqual([]);
    expect(report.unknown).toEqual(["SHARED", "URL", "HOST", "PORT"]);
    const issues = toConfigIssues(report);
    expect(issues).toEqual([
      { kind: "missing", path: "REQUIRED_BUT_MISSING", reason: "required variable is not set" },
    ]);
  });

  test("against an example file, with empty detection", async () => {
    const report = await Effect.runPromise(
      check({ cwd, files: [".env"], env: { MISSING_IN_FILES: "" }, example: ".env.example" }),
    );
    expect(report.missing).toEqual([]);
    expect(report.empty).toEqual(["MISSING_IN_FILES"]);
    const lenient = await Effect.runPromise(
      check({
        cwd,
        files: [".env"],
        env: { MISSING_IN_FILES: "" },
        example: ".env.example",
        allowEmpty: true,
      }),
    );
    expect(lenient.empty).toEqual([]);
  });

  test("needs something to check against", async () => {
    const exit = await Effect.runPromiseExit(check({ cwd, files: [".env"], env: {} }));
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe("setValues / unsetKeys", () => {
  test("edit a file in place and create it when absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "structure-dotenv-write-"));
    const file = join(dir, ".env");
    try {
      await writeFile(file, "# keep me\nA=1\nB=2\n");
      await Effect.runPromise(setValues(file, { A: "one two", C: "3" }));
      expect(await Bun.file(file).text()).toBe("# keep me\nA='one two'\nB=2\nC=3\n");
      await Effect.runPromise(unsetKeys(file, ["B", "NOPE"]));
      expect(await Bun.file(file).text()).toBe("# keep me\nA='one two'\nC=3\n");
      const fresh = join(dir, ".env.new");
      await Effect.runPromise(setValues(fresh, { X: "y" }));
      expect(await Bun.file(fresh).text()).toBe("X=y\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
