import { expect, test } from "bun:test";
import { type CommandBus, HandlerRegistry, layer } from "@structure-ai/cqrs";
import { Context, Effect, Layer, Schema } from "effect";
import {
  defineFixture,
  defineScenario,
  type FixtureError,
  makeCatalog,
  run,
} from "../src/index.js";

class Names extends Context.Tag("fixtures-test/Names")<Names, { readonly name: string }>() {}
class Readiness extends Context.Tag("fixtures-test/Readiness")<
  Readiness,
  { readonly verify: Effect.Effect<void> }
>() {}
const shared = defineFixture({
  key: "shared",
  create: () => Effect.map(Names, ({ name }) => ({ name })),
});
const child = defineFixture({
  key: "child",
  dependencies: { shared },
  create: ({ dependencies }) => Effect.succeed(dependencies.shared.name.length),
});
const operation = run({
  fixtures: { child },
  enabled: true,
  ready: () => Effect.flatMap(Readiness, ({ verify }) => verify),
});

// A dependency's service must survive graph composition, and ready adds its own requirement.
const typed: Effect.Effect<unknown, FixtureError, CommandBus | Names | Readiness> = operation;
// @ts-expect-error Names and Readiness still need providers.
const missing: Effect.Effect<unknown, FixtureError, CommandBus> = operation;
void missing;
const scenario = defineScenario({
  name: "typed",
  description: "",
  input: Schema.Struct({}),
  fixtures: () => ({ child }),
});
const catalog = makeCatalog({ base: {}, scenarios: [scenario] });
const fromCatalog = Effect.flatMap(catalog.prepare("typed"), (fixtures) =>
  run({ fixtures, enabled: true, ready: () => Effect.void }),
);
// @ts-expect-error A catalog must not erase Names, inherited from child's dependency.
const missingCatalog: Effect.Effect<unknown, FixtureError, CommandBus> = fromCatalog;
void missingCatalog;

test("typed dependency services and readiness are provided by the application", async () => {
  const bus = layer.pipe(Layer.provide(HandlerRegistry.layer()));
  const provided = Layer.mergeAll(
    bus,
    Layer.succeed(Names, { name: "Ada" }),
    Layer.succeed(Readiness, { verify: Effect.void }),
  );
  await Effect.runPromise(typed.pipe(Effect.provide(provided)));
  const result = await Effect.runPromise(operation.pipe(Effect.provide(provided)));
  const count: number = result.values.child;
  expect(count).toBe(3);
  expect((await Effect.runPromise(fromCatalog.pipe(Effect.provide(provided)))).values.child).toBe(
    3,
  );
});

const withReadiness = defineScenario({
  name: "other",
  description: "",
  input: Schema.Struct({}),
  fixtures: () => ({
    probe: defineFixture({
      key: "probe",
      create: () => Effect.flatMap(Readiness, ({ verify }) => verify),
    }),
  }),
});
const mixedCatalog = makeCatalog({ base: {}, scenarios: [scenario, withReadiness] });
const mixed = Effect.flatMap(mixedCatalog.prepare("other"), (fixtures) =>
  run({ fixtures, enabled: true, ready: () => Effect.void }),
);
// @ts-expect-error Heterogeneous scenarios retain every possible service requirement.
const incompleteMixed: Effect.Effect<unknown, FixtureError, CommandBus | Names> = mixed;
void incompleteMixed;
