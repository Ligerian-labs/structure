import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import type { ExpressionParams } from "../src/index.js";
import { DataTable } from "../src/index.js";
import { compileExpression, Given } from "../src/steps.js";
import { checkWiring, parseFeatures } from "../src/suite.js";

// --- data tables --------------------------------------------------------------

const table = new DataTable([
  ["email", "nights"],
  ["valentin@example.test", "7"],
  ["cloe@example.test", "14"],
]);

describe("DataTable", () => {
  test("hashes keys rows by the header", () => {
    expect(table.hashes()).toEqual([
      { email: "valentin@example.test", nights: "7" },
      { email: "cloe@example.test", nights: "14" },
    ]);
  });

  test("rows decode through a struct schema, converting values", async () => {
    const rowSchema = Schema.Struct({
      email: Schema.String,
      nights: Schema.NumberFromString,
    });
    const rows = await Effect.runPromise(table.rows(rowSchema));
    expect(rows).toEqual([
      { email: "valentin@example.test", nights: 7 },
      { email: "cloe@example.test", nights: 14 },
    ]);
  });

  test("rows fail with schema issues when a cell does not conform", async () => {
    const rowSchema = Schema.Struct({ email: Schema.String, nights: Schema.NumberFromString });
    const bad = new DataTable([
      ["email", "nights"],
      ["x@example.test", "seven"],
    ]);
    const exit = await Effect.runPromise(Effect.exit(bad.rows(rowSchema)));
    expect(exit._tag).toBe("Failure");
  });
});

// --- expression typing and matching --------------------------------------------

describe("cucumber expressions", () => {
  test("{string} and {int} parameters extract typed values", () => {
    const match = compileExpression("a rate of {int} € for villa {string}").match(
      'a rate of 300 € for villa "savanne"',
    );
    expect(match).not.toBeNull();
    const values = (match ?? []).map((argument) => argument.getValue<unknown>(undefined));
    expect(values).toEqual([300, "savanne"]);
  });

  test("optional groups match both forms", () => {
    const expression = compileExpression("{int} email(s) should have been sent");
    expect(expression.match("1 email should have been sent")).not.toBeNull();
    expect(expression.match("2 emails should have been sent")).not.toBeNull();
  });

  test("ExpressionParams types parameters from the literal", () => {
    const typed: ExpressionParams<"a {string} with {int} rooms"> = ["savanne", 3];
    expect(typed).toEqual(["savanne", 3]);
    // @ts-expect-error — the tuple order is part of the type
    const wrong: ExpressionParams<"a {string} with {int} rooms"> = [3, "savanne"];
    expect(wrong.length).toBe(2);
  });
});

// --- feature parsing and wiring checks ------------------------------------------

const featureFixture = `Feature: Wiring
  Scenario: All steps known
    Given a known step
    When another known step
  Scenario: Missing step
    Then a step nobody defined
`;

describe("feature wiring", () => {
  test("features parse into scenarios with steps, tags and lines", () => {
    const path = `${import.meta.dir}/wiring.feature.fixture`;
    require("node:fs").writeFileSync(path, featureFixture);
    try {
      const features = parseFeatures("test/wiring.feature.fixture");
      expect(features).toHaveLength(1);
      const [feature] = features;
      expect(feature?.name).toBe("Wiring");
      expect(feature?.scenarios).toHaveLength(2);
      const [allKnown, missing] = feature?.scenarios ?? [];
      expect(allKnown?.steps.map((step) => step.text)).toEqual([
        "a known step",
        "another known step",
      ]);
      expect(allKnown?.steps[0]?.line).toBeGreaterThan(0);
      expect(missing?.name).toBe("Missing step");
    } finally {
      require("node:fs").rmSync(path);
    }
  });

  test("undefined steps fail the wiring check with file and line", () => {
    const path = `${import.meta.dir}/wiring.feature.fixture`;
    require("node:fs").writeFileSync(path, featureFixture);
    try {
      const features = parseFeatures("test/wiring.feature.fixture");
      const steps = [Given("a known step", () => {}), Given("another known step", () => {})];
      expect(() => checkWiring(features, steps)).toThrow(/undefined step.*nobody defined/s);
    } finally {
      require("node:fs").rmSync(path);
    }
  });

  test("ambiguous steps fail the wiring check listing every match", () => {
    const path = `${import.meta.dir}/wiring.feature.fixture`;
    require("node:fs").writeFileSync(
      path,
      `Feature: Ambiguity
  Scenario: Doubled
    Given a known step
`,
    );
    try {
      const features = parseFeatures("test/wiring.feature.fixture");
      const steps = [Given("a known step", () => {}), Given("a {word} step", () => {})];
      expect(() => checkWiring(features, steps)).toThrow(/ambiguous step.*a \{word\} step/s);
    } finally {
      require("node:fs").rmSync(path);
    }
  });

  test("wip scenarios are exempt from wiring checks", () => {
    const path = `${import.meta.dir}/wiring.feature.fixture`;
    require("node:fs").writeFileSync(
      path,
      `Feature: Wip
  @wip
  Scenario: Not written yet
    Given a step nobody defined
`,
    );
    try {
      const features = parseFeatures("test/wiring.feature.fixture");
      expect(() => checkWiring(features, [])).not.toThrow();
    } finally {
      require("node:fs").rmSync(path);
    }
  });
});

// --- text conventions ----------------------------------------------------------

describe("text conventions", () => {
  test("norm collapses locale whitespace (incl. narrow no-break)", async () => {
    const { norm } = await import("../src/index.js");
    expect(norm("4\u202F200,00\u00A0€")).toBe("4 200,00 €");
    expect(norm("  simple   text  ")).toBe("simple text");
  });

  test("ddMmYyyyToIso converts and validates", async () => {
    const { ddMmYyyyToIso } = await import("../src/index.js");
    expect(ddMmYyyyToIso("05/03/2022")).toBe("2022-03-05");
    expect(ddMmYyyyToIso("12/08/1990")).toBe("1990-08-12");
    expect(() => ddMmYyyyToIso("2022-03-05")).toThrow(/dd\/MM\/yyyy/);
  });
});

// --- null literal in tables ------------------------------------------------------

describe("DataTable nullLiteral", () => {
  test("cells equal to the literal decode to null", async () => {
    const { Schema } = await import("effect");
    const schema = Schema.Struct({ email: Schema.String, referral: Schema.NullOr(Schema.String) });
    const rows = await Effect.runPromise(
      new DataTable([
        ["email", "referral"],
        ["a@test.dev", "NULL"],
        ["b@test.dev", "friends"],
      ]).rows(schema, { nullLiteral: "NULL" }),
    );
    expect(rows).toEqual([
      { email: "a@test.dev", referral: null },
      { email: "b@test.dev", referral: "friends" },
    ]);
  });
});

// --- world.attempt ---------------------------------------------------------------

describe("ScenarioWorld.attempt", () => {
  test("records any effect's outcome like a dispatch", async () => {
    const { Effect: E, Context, Exit } = await import("effect");
    const { ScenarioWorld } = await import("../src/index.js");

    class W extends ScenarioWorld<never> {}
    const program = E.gen(function* () {
      const world = new W(yield* E.scope, Context.empty());
      const first = yield* world.attempt(E.succeed("ok"));
      yield* world.attempt(E.fail({ _tag: "Boom" as const }));
      return { success: Exit.isSuccess(first), failureTag: world.failureTags()[0] };
    });
    const result = await E.runPromise(E.scoped(program));
    expect(result.success).toBe(true);
    expect(result.failureTag).toBe("Boom");
  });
});
