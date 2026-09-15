import { expect, test } from "bun:test";
import { Command as CliCommand, runCliForTest } from "@structure-ai/cli";
import { Command, CommandHandler, HandlerRegistry, layer } from "@structure-ai/cqrs";
import { Console, Effect, Layer, Schema } from "effect";
import { fixturesCommand } from "../src/cli.js";
import { defineFixture, defineScenario, makeCatalog } from "../src/index.js";

const Create = Command.define("FixtureCliCreate", {
  payload: Schema.Struct({ id: Schema.UUID, name: Schema.String }),
  success: Schema.String,
});
const capture = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const original = yield* Console.consoleWith(Effect.succeed);
    const stdout: Array<string> = [];
    const stderr: Array<string> = [];
    const result = yield* effect.pipe(
      Console.withConsole({
        ...original,
        log: (...args: ReadonlyArray<unknown>) =>
          Effect.sync(() => {
            stdout.push(args.map(String).join(" "));
          }),
        error: (...args: ReadonlyArray<unknown>) =>
          Effect.sync(() => {
            stderr.push(args.map(String).join(" "));
          }),
      }),
    );
    return { result, stdout, stderr };
  });

const setup = (enabled: boolean) => {
  const created: Array<string> = [];
  const cleaned: Array<string> = [];
  let ready = false;
  const base = defineFixture({
    key: "base",
    create: ({ dispatch, id }) => dispatch(Create, { id: id("base"), name: "base" }),
  });
  const scenario = defineScenario({
    name: "sales",
    description: "Sales fixture",
    input: Schema.Struct({ name: Schema.String }),
    fixtures: ({ name }) => ({
      buyer: defineFixture({
        key: "buyer",
        create: ({ dispatch, id }) =>
          dispatch(Create, { id: id("buyer"), name }).pipe(
            Effect.as({ password: "never-print-this" }),
          ),
      }),
    }),
  });
  const catalog = makeCatalog({ base: { base }, scenarios: [scenario] });
  const app = layer.pipe(
    Layer.provide(
      HandlerRegistry.layer(
        CommandHandler.make(Create, ({ id }) =>
          Effect.sync(() => {
            created.push(id);
            return id;
          }),
        ),
      ),
    ),
  );
  const root = fixturesCommand(catalog, {
    enabled,
    ready: () =>
      Effect.sync(() => {
        ready = true;
      }),
    cleanup: (id) =>
      Effect.sync(() => {
        cleaned.push(id);
      }),
  }).pipe(CliCommand.provide(app));
  const invoke = (args: ReadonlyArray<string>) =>
    Effect.runPromise(capture(runCliForTest(root, args)));
  return { invoke, created, cleaned, isReady: () => ready };
};

test("CLI list and plan work while fixtures are disabled and perform no commands", async () => {
  const app = setup(false);
  const listed = await app.invoke(["list"]);
  expect(listed.result.exitCode).toBe(0);
  expect(JSON.parse(listed.stdout[0] ?? "null")).toEqual([
    { name: "sales", description: "Sales fixture" },
  ]);
  const planned = await app.invoke(["plan", "sales", "--input", '{"name":"Buyer"}']);
  expect(planned.result.exitCode).toBe(0);
  expect(JSON.parse(planned.stdout[0] ?? "null")).toEqual({
    scenario: "sales",
    fixtures: ["base", "buyer"],
  });
  expect(app.created).toHaveLength(0);
});

test("CLI loads base and scenario, awaits readiness and prints only generated IDs", async () => {
  const app = setup(true);
  const loaded = await app.invoke(["load", "sales", "--input", '{"name":"Buyer"}']);
  expect(loaded.result.exitCode).toBe(0);
  expect(app.created).toHaveLength(2);
  expect(app.isReady()).toBe(true);
  expect(loaded.stdout.join()).not.toContain("never-print-this");
  expect(loaded.stderr.join()).toContain("fixtures.progress");
  const receipt = Schema.decodeUnknownSync(
    Schema.Struct({ runId: Schema.UUID, completed: Schema.Array(Schema.String) }),
  )(JSON.parse(loaded.stdout[0] ?? "null"));
  expect(receipt.completed).toEqual(["base", "buyer"]);
  expect((await app.invoke(["cleanup", receipt.runId])).result.exitCode).toBe(0);
  expect(app.cleaned).toEqual([receipt.runId]);
});

test("CLI rejects disabled writes, malformed JSON, invalid input, unknown scenarios and flags", async () => {
  const app = setup(true);
  for (const args of [
    ["load", "sales", "--input", "{"],
    ["load", "sales", "--input", '{"name":1}'],
    ["load", "missing"],
    ["load", "sales", "--force"],
  ]) {
    expect((await app.invoke(args)).result.exitCode).not.toBe(0);
  }
  const disabled = setup(false);
  expect(
    (await disabled.invoke(["load", "sales", "--input", '{"name":"Buyer"}'])).result.exitCode,
  ).toBe(1);
  expect((await disabled.invoke(["cleanup", crypto.randomUUID()])).result.exitCode).toBe(1);
  expect(app.created).toHaveLength(0);
  expect(disabled.created).toHaveLength(0);
  expect(disabled.cleaned).toHaveLength(0);
});
