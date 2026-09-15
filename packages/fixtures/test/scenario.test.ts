import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { defineFixture, defineScenario, makeCatalog, plan } from "../src/index.js";

const base = defineFixture({
  key: "base/users",
  create: () => Effect.succeed({ userId: "existing" }),
});
const sales = defineScenario({
  name: "sales/stock",
  description: "Stock available to sell",
  input: Schema.Struct({ count: Schema.Number.pipe(Schema.int(), Schema.between(1, 10)) }),
  fixtures: ({ count }) =>
    Object.fromEntries(
      Array.from({ length: count }, (_, index) => [
        String(index),
        defineFixture({
          key: `sales/product-${index}`,
          dependencies: { base },
          create: ({ dependencies }) => Effect.succeed(dependencies.base.userId),
        }),
      ]),
    ),
});
const catalog = makeCatalog({ base: { base }, scenarios: [sales] });

test("catalog selects a parameterized scenario and includes shared base once", async () => {
  const fixtures = await Effect.runPromise(catalog.prepare("sales/stock", { count: 2 }));
  expect(await Effect.runPromise(plan(fixtures))).toEqual([
    "base/users",
    "sales/product-0",
    "sales/product-1",
  ]);
  expect(await Effect.runPromise(catalog.list)).toEqual([
    { name: "sales/stock", description: "Stock available to sell" },
  ]);
});

test("invalid inputs and excess properties fail before the builder runs", async () => {
  let built = false;
  const scenario = defineScenario({
    name: "example",
    description: "",
    input: Schema.Struct({ count: Schema.Number }),
    fixtures: () => {
      built = true;
      return {};
    },
  });
  for (const input of [{ count: "secret-input" }, { count: 1, typo: true }]) {
    const result = await Effect.runPromise(scenario.prepare(input).pipe(Effect.either));
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left.message).not.toContain("secret-input");
  }
  expect(built).toBe(false);
});

test("catalog rejects unknown names, duplicate names and root alias conflicts", async () => {
  expect((await Effect.runPromise(catalog.prepare("missing").pipe(Effect.either)))._tag).toBe(
    "Left",
  );
  expect(
    (
      await Effect.runPromise(
        makeCatalog({ base: {}, scenarios: [sales, sales] }).list.pipe(Effect.either),
      )
    )._tag,
  ).toBe("Left");
  const conflicting = defineScenario({
    name: "base",
    description: "",
    input: Schema.Struct({}),
    fixtures: () => ({ base: defineFixture({ key: "different", create: () => Effect.void }) }),
  });
  const result = await Effect.runPromise(
    makeCatalog({ base: { base }, scenarios: [conflicting] })
      .prepare("base")
      .pipe(Effect.either),
  );
  expect(result._tag).toBe("Left");
});

test("base roots precede independent feature roots with integer-like aliases", async () => {
  const scenario = defineScenario({
    name: "numbered",
    description: "",
    input: Schema.Struct({}),
    fixtures: () => ({ "0": defineFixture({ key: "feature", create: () => Effect.void }) }),
  });
  const roots = await Effect.runPromise(
    makeCatalog({ base: { base }, scenarios: [scenario] }).prepare("numbered"),
  );
  expect(await Effect.runPromise(plan(roots))).toEqual(["base/users", "feature"]);
});
