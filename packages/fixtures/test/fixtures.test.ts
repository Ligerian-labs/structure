import { describe, expect, test } from "bun:test";
import { Command, CommandHandler, HandlerRegistry, layer } from "@structure-ai/cqrs";
import { Effect, Layer, Schema } from "effect";
import { defineFixture, plan, run } from "../src/index.js";

const CreateRecord = Command.define("CreateFixtureRecord", {
  payload: Schema.Struct({
    id: Schema.UUID,
    ownerId: Schema.optional(Schema.UUID),
    title: Schema.String,
  }),
  success: Schema.Struct({ id: Schema.UUID }),
});

const app = () => {
  const records: Array<{ id: string; ownerId?: string | undefined; title: string }> = [];
  const handlers = HandlerRegistry.layer(
    CommandHandler.make(CreateRecord, (payload) =>
      Effect.sync(() => {
        records.push(payload);
        return { id: payload.id };
      }),
    ),
  );
  return { records, layer: layer.pipe(Layer.provide(handlers)) };
};

const organization = defineFixture({
  key: "base/organization",
  create: ({ dispatch, id }) =>
    dispatch(CreateRecord, { id: id("organization"), title: "Example organization" }),
});
const customer = (key: string) =>
  defineFixture({
    key,
    dependencies: { organization },
    create: ({ dispatch, id, dependencies }) =>
      dispatch(CreateRecord, {
        id: id("customer"),
        ownerId: dependencies.organization.id,
        title: key,
      }),
  });

describe("composable fixtures", () => {
  test("plans dependency order and shares an explicit fixture object", async () => {
    const buyer = customer("sales/buyer");
    expect(await Effect.runPromise(plan({ organization, buyer, sameBuyer: buyer }))).toEqual([
      "base/organization",
      "sales/buyer",
    ]);
  });

  test("creates through the command bus once per instance and waits for readiness", async () => {
    const world = app();
    const buyer = customer("sales/buyer");
    let ready = false;
    const report = await Effect.runPromise(
      run({
        fixtures: { organization, buyer, sameBuyer: buyer },
        enabled: true,
        ready: (result) =>
          Effect.sync(() => {
            expect(world.records).toHaveLength(2);
            expect(world.records[1]?.id).toBe(result.values.buyer.id);
            ready = true;
          }),
      }).pipe(Effect.provide(world.layer)),
    );
    expect(ready).toBe(true);
    expect(report.values.buyer).toBe(report.values.sameBuyer);
    expect(world.records[1]?.ownerId).toBe(report.values.organization.id);
    expect(report.completed).toEqual(["base/organization", "sales/buyer"]);
  });

  test("separate named instances and separate invocations get different IDs; data remains", async () => {
    const world = app();
    const operation = run({
      fixtures: { a: customer("buyer/a"), b: customer("buyer/b") },
      enabled: true,
      ready: () => Effect.void,
    });
    const [first, second] = await Effect.runPromise(
      Effect.gen(function* () {
        return [yield* operation, yield* operation] as const;
      }).pipe(Effect.provide(world.layer)),
    );
    expect(first.runId).not.toBe(second.runId);
    expect(first.values.a.id).not.toBe(first.values.b.id);
    expect(first.values.a.id).not.toBe(second.values.a.id);
    expect(world.records).toHaveLength(6);
  });

  test("rejects conflicting instance keys before creating base data", async () => {
    const world = app();
    const result = await Effect.runPromise(
      run({
        fixtures: { a: customer("buyer"), b: customer("buyer") },
        enabled: true,
        ready: () => Effect.void,
      }).pipe(Effect.either, Effect.provide(world.layer)),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left.message).toContain("buyer");
    expect(world.records).toHaveLength(0);
  });

  test("disables mutation by default", async () => {
    const world = app();
    const result = await Effect.runPromise(
      run({ fixtures: { organization }, ready: () => Effect.void }).pipe(
        Effect.either,
        Effect.provide(world.layer),
      ),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left.message).toContain("disabled");
    expect(world.records).toHaveLength(0);
  });
});

test("dependency cycles and invalid keys fail during planning", async () => {
  const dependencies: Record<string, import("../src/index.js").Fixture<void>> = {};
  const cycle: import("../src/index.js").Fixture<void> = {
    key: "cycle",
    dependencies,
    create: () => Effect.void,
  };
  dependencies.self = cycle;
  for (const fixtures of [
    { cycle },
    { invalid: defineFixture({ key: "unsafe\nkey", create: () => Effect.void }) },
  ]) {
    expect((await Effect.runPromise(plan(fixtures).pipe(Effect.either)))._tag).toBe("Left");
  }
});

test("command failures stop dependents, keep completed data and retain safe failure context", async () => {
  const world = app();
  let reached = false;
  const broken = defineFixture({
    key: "broken",
    dependencies: { organization },
    create: () => Effect.fail({ classification: "conflict", private: "secret-payload" }),
  });
  const dependent = defineFixture({
    key: "dependent",
    dependencies: { broken },
    create: () =>
      Effect.sync(() => {
        reached = true;
      }),
  });
  const result = await Effect.runPromise(
    run({ fixtures: { dependent }, enabled: true, ready: () => Effect.void }).pipe(
      Effect.either,
      Effect.provide(world.layer),
    ),
  );
  expect(result._tag).toBe("Left");
  if (result._tag === "Left") {
    expect(result.left.classification).toBe("conflict");
    expect(result.left.completed).toEqual(["base/organization"]);
    expect(result.left.step).toBe("broken");
    expect(result.left.runId).toBeDefined();
    expect(result.left.cause).toBeDefined();
    expect(result.left.message).not.toContain("secret-payload");
  }
  expect(world.records).toHaveLength(1);
  expect(reached).toBe(false);
});

test("a command validation failure prevents any write", async () => {
  const world = app();
  const bad = defineFixture({
    key: "bad",
    create: ({ dispatch }) => dispatch(CreateRecord, { id: "not-a-uuid", title: "bad" }),
  });
  const result = await Effect.runPromise(
    run({ fixtures: { bad }, enabled: true, ready: () => Effect.void }).pipe(
      Effect.either,
      Effect.provide(world.layer),
    ),
  );
  expect(result._tag).toBe("Left");
  expect(world.records).toHaveLength(0);
});

test("IDs are stable within a run, namespaced by fixture and recorded without outputs", async () => {
  const world = app();
  const one = (key: string) =>
    defineFixture({
      key,
      create: ({ id }) =>
        Effect.sync(() => {
          expect(id("user")).toBe(id("user"));
          return { password: "secret", id: id("user") };
        }),
    });
  const report = await Effect.runPromise(
    run({ fixtures: { a: one("a"), b: one("b") }, enabled: true, ready: () => Effect.void }).pipe(
      Effect.provide(world.layer),
    ),
  );
  expect(report.ids.a?.user).toBe(report.values.a.id);
  expect(report.values.a.id).not.toBe(report.values.b.id);
  expect(JSON.stringify(report.ids)).not.toContain("secret");
});

test("readiness failure retains data and names the failed step", async () => {
  const world = app();
  const result = await Effect.runPromise(
    run({
      fixtures: { organization },
      enabled: true,
      ready: () => Effect.fail({ classification: "transient" }),
    }).pipe(Effect.either, Effect.provide(world.layer)),
  );
  expect(result._tag).toBe("Left");
  if (result._tag === "Left") {
    expect(result.left.step).toBe("ready");
    expect(result.left.classification).toBe("transient");
    expect(result.left.completed).toEqual(["base/organization"]);
  }
  expect(world.records).toHaveLength(1);
});
