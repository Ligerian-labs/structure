import { describe, expect, test } from "bun:test";
import { ConfigLoadError } from "@structure/config";
import { Cause, Data, Effect, FiberId, Layer, LogLevel, Option } from "effect";
import {
  Args,
  defineCommand,
  EXIT_CONFIG,
  EXIT_SOFTWARE,
  EXIT_SUCCESS,
  EXIT_TEMPFAIL,
  EXIT_USAGE,
  exitCodeFor,
  Options,
  runCliForTest,
  type StandardValues,
  standardLayers,
  standardOptions,
  withSubcommands,
} from "../src/index.js";

// @structure/domain is not a declared dependency of this package, so these
// mirror its tagged-error shape (`classification` field) structurally.
class InvariantViolation extends Data.TaggedError("InvariantViolation")<{
  readonly rule: string;
}> {
  readonly classification = "permanent";
}

class DispatchTimeout extends Data.TaggedError("DispatchTimeout")<{
  readonly reason: string;
}> {
  readonly classification = "transient";
}

class ConcurrencyConflict extends Data.TaggedError("ConcurrencyConflict")<{
  readonly entity: string;
}> {
  readonly classification = "conflict";
}

const run = <A>(effect: Effect.Effect<A>): Promise<A> => Effect.runPromise(effect);

describe("defineCommand", () => {
  test("handler receives parsed, typed option and argument values", async () => {
    let received: { readonly count: number; readonly who: string } | undefined;
    const greet = defineCommand({
      name: "greet",
      description: "print a greeting",
      options: { count: Options.integer("count") },
      args: { who: Args.text({ name: "who" }) },
      handler: (input) =>
        Effect.sync(() => {
          received = input;
        }),
    });
    const outcome = await run(runCliForTest(greet, ["--count", "3", "world"]));
    expect(outcome.exitCode).toBe(EXIT_SUCCESS);
    expect(received).toEqual({ count: 3, who: "world" });
  });

  test("a command with no options or args runs its handler", async () => {
    let ran = false;
    const noop = defineCommand({
      name: "noop",
      handler: () =>
        Effect.sync(() => {
          ran = true;
        }),
    });
    const outcome = await run(runCliForTest(noop, []));
    expect(outcome.exitCode).toBe(EXIT_SUCCESS);
    expect(ran).toBe(true);
  });

  test("handler failure propagates as the mapped exit code", async () => {
    const failing = defineCommand({
      name: "failing",
      handler: () => Effect.fail(new DispatchTimeout({ reason: "queue full" })),
    });
    const outcome = await run(runCliForTest(failing, []));
    expect(outcome.exitCode).toBe(EXIT_TEMPFAIL);
    expect(outcome.cause).toBeDefined();
  });

  test("a ConfigLoadError failure exits 78 and surfaces its message", async () => {
    const broken = defineCommand({
      name: "broken",
      handler: () =>
        Effect.fail(
          new ConfigLoadError({
            issues: [{ kind: "missing", path: "PORT", reason: "expected a value" }],
          }),
        ),
    });
    const outcome = await run(runCliForTest(broken, []));
    expect(outcome.exitCode).toBe(EXIT_CONFIG);
    expect(outcome.errorMessage).toContain("PORT");
    expect(outcome.errorMessage).toContain("missing");
  });
});

describe("subcommands", () => {
  const makeRoot = (onAdd: (value: number) => void, onRoot: () => void) => {
    const add = defineCommand({
      name: "add",
      options: { value: Options.integer("value") },
      handler: ({ value }) => Effect.sync(() => onAdd(value)),
    });
    const root = defineCommand({
      name: "root",
      handler: () => Effect.sync(onRoot),
    });
    return withSubcommands(root, [add]);
  };

  test("routes to the matched subcommand handler", async () => {
    let added: number | undefined;
    let rootRan = false;
    const root = makeRoot(
      (value) => {
        added = value;
      },
      () => {
        rootRan = true;
      },
    );
    const outcome = await run(runCliForTest(root, ["add", "--value", "42"]));
    expect(outcome.exitCode).toBe(EXIT_SUCCESS);
    expect(added).toBe(42);
    expect(rootRan).toBe(false);
  });

  test("runs the parent handler when no subcommand is given", async () => {
    let rootRan = false;
    const root = makeRoot(
      () => undefined,
      () => {
        rootRan = true;
      },
    );
    const outcome = await run(runCliForTest(root, []));
    expect(outcome.exitCode).toBe(EXIT_SUCCESS);
    expect(rootRan).toBe(true);
  });
});

describe("standard options", () => {
  const capture = () => {
    let values: StandardValues | undefined;
    const command = defineCommand({
      name: "app",
      options: standardOptions,
      handler: (input) =>
        Effect.sync(() => {
          values = input;
        }),
    });
    return { command, values: () => values };
  };

  test("--log-level debug parses to LogLevel.Debug", async () => {
    const { command, values } = capture();
    const outcome = await run(runCliForTest(command, ["--log-level", "debug"]));
    expect(outcome.exitCode).toBe(EXIT_SUCCESS);
    expect(values()?.logLevel).toBe(LogLevel.Debug);
  });

  test("--log-format pretty is accepted", async () => {
    const { command, values } = capture();
    const outcome = await run(runCliForTest(command, ["--log-format", "pretty"]));
    expect(outcome.exitCode).toBe(EXIT_SUCCESS);
    expect(values()?.logFormat).toBe("pretty");
  });

  test("defaults: info level, json format, no config file", async () => {
    const { command, values } = capture();
    const outcome = await run(runCliForTest(command, []));
    expect(outcome.exitCode).toBe(EXIT_SUCCESS);
    expect(values()?.logLevel).toBe(LogLevel.Info);
    expect(values()?.logFormat).toBe("json");
    expect(values()?.configFile).toEqual(Option.none());
  });

  test("--config-file threads through as Option.some", async () => {
    const { command, values } = capture();
    const outcome = await run(runCliForTest(command, ["--config-file", "settings.json"]));
    expect(outcome.exitCode).toBe(EXIT_SUCCESS);
    expect(values()?.configFile).toEqual(Option.some("settings.json"));
  });

  test("invalid --log-level value is a usage failure with a nonzero exit", async () => {
    const { command } = capture();
    const outcome = await run(runCliForTest(command, ["--log-level", "verbose"]));
    expect(outcome.exitCode).toBe(EXIT_USAGE);
    expect(outcome.errorMessage).toBeDefined();
  });

  test("standardLayers yields observability layer and config LoadOptions", () => {
    const wiring = standardLayers(
      {
        logLevel: LogLevel.Debug,
        logFormat: "pretty",
        configFile: Option.some("settings.json"),
      },
      "my-service",
    );
    expect(Layer.isLayer(wiring.observability)).toBe(true);
    expect(wiring.loadOptions).toEqual({ configFile: "settings.json" });

    const bare = standardLayers(
      { logLevel: LogLevel.Info, logFormat: "json", configFile: Option.none() },
      { name: "my-service", version: "1.0.0" },
    );
    expect(bare.loadOptions).toEqual({});
  });
});

describe("exitCodeFor", () => {
  test("ConfigLoadError maps to 78 (EX_CONFIG)", () => {
    const error = new ConfigLoadError({
      issues: [{ kind: "invalid", path: "URL", reason: "not a url" }],
    });
    expect(exitCodeFor(error)).toBe(EXIT_CONFIG);
    expect(exitCodeFor(Cause.fail(error))).toBe(EXIT_CONFIG);
  });

  test("permanent classification maps to 1", () => {
    expect(exitCodeFor(new InvariantViolation({ rule: "no negatives" }))).toBe(1);
  });

  test("conflict classification maps to 1", () => {
    expect(exitCodeFor(new ConcurrencyConflict({ entity: "order" }))).toBe(1);
  });

  test("transient classification maps to 75 (EX_TEMPFAIL)", () => {
    expect(exitCodeFor(new DispatchTimeout({ reason: "busy" }))).toBe(EXIT_TEMPFAIL);
    expect(exitCodeFor(Cause.fail(new DispatchTimeout({ reason: "busy" })))).toBe(EXIT_TEMPFAIL);
  });

  test("unclassified failures map to 1", () => {
    expect(exitCodeFor(new Error("plain"))).toBe(1);
  });

  test("defect cause maps to 70 (EX_SOFTWARE)", () => {
    expect(exitCodeFor(Cause.die(new Error("boom")))).toBe(EXIT_SOFTWARE);
  });

  test("pure interruption maps to 130 and empty cause to 0", () => {
    expect(exitCodeFor(Cause.interrupt(FiberId.none))).toBe(130);
    expect(exitCodeFor(Cause.empty)).toBe(EXIT_SUCCESS);
  });

  test("a defect thrown in a handler maps to 70 via runCliForTest", async () => {
    const exploding = defineCommand({
      name: "exploding",
      handler: () =>
        Effect.sync(() => {
          throw new Error("boom");
        }),
    });
    const outcome = await run(runCliForTest(exploding, []));
    expect(outcome.exitCode).toBe(EXIT_SOFTWARE);
    expect(outcome.errorMessage).toContain("boom");
  });
});
