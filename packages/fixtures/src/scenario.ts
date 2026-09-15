import { Effect, Schema } from "effect";
import {
  type Fixture,
  FixtureError,
  type Fixtures,
  mergeRoots,
  type Requirements,
} from "./fixture.js";

type FixtureSet<R> = Readonly<Record<string, Fixture<unknown, unknown, R>>>;

export interface Scenario<R> {
  readonly name: string;
  readonly description: string;
  /** Decode CLI/agent input before constructing any fixture instances. Builders must be pure. */
  readonly prepare: (input: unknown) => Effect.Effect<FixtureSet<R>, FixtureError>;
}

/** An input schema and a pure builder for one feature's named fixture instances. */
export const defineScenario = <I, Encoded, const F extends Fixtures>(definition: {
  readonly name: string;
  readonly description: string;
  readonly input: Schema.Schema<I, Encoded>;
  readonly fixtures: (input: I) => F;
}): Scenario<Requirements<F>> =>
  Object.freeze({
    name: definition.name,
    description: definition.description,
    prepare: (input: unknown) =>
      Schema.decodeUnknown(definition.input, { onExcessProperty: "error" })(input).pipe(
        Effect.mapError(
          () =>
            new FixtureError({
              reason: "input",
              detail: `Invalid input for scenario ${definition.name}; consult its input schema`,
              classification: "permanent",
            }),
        ),
        Effect.flatMap((decoded) =>
          Effect.try({
            // Each member's requirements are included in the union extracted from F.
            try: () => definition.fixtures(decoded) as FixtureSet<Requirements<F>>,
            catch: (cause) =>
              new FixtureError({
                reason: "definition",
                detail: `Could not build scenario ${definition.name}`,
                cause,
                classification: "permanent",
              }),
          }),
        ),
      ),
  });

export interface Catalog<R> {
  readonly list: Effect.Effect<
    ReadonlyArray<{ readonly name: string; readonly description: string }>,
    FixtureError
  >;
  /** Includes base roots first. Duplicate aliases are allowed only for the very same instance. */
  readonly prepare: (name: string, input?: unknown) => Effect.Effect<FixtureSet<R>, FixtureError>;
}

type ScenarioRequirements<S extends ReadonlyArray<Scenario<unknown>>> = {
  [K in keyof S]: S[K] extends Scenario<infer R> ? R : never;
}[number];

/** Base fixtures run for every selected scenario. A base-only scenario can return an empty record. */
export const makeCatalog = <
  const B extends Fixtures,
  const S extends ReadonlyArray<Scenario<unknown>>,
>(options: {
  readonly base: B;
  readonly scenarios: S;
}): Catalog<Requirements<B> | ScenarioRequirements<S>> => {
  const base = { ...options.base };
  const scenarios = [...options.scenarios];
  const validate = Effect.gen(function* () {
    const names = new Set<string>();
    for (const scenario of scenarios) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9/_-]{0,127}$/.test(scenario.name) || names.has(scenario.name)) {
        return yield* new FixtureError({
          reason: "definition",
          detail: "Scenario names must be unique and use 1-128 letters, digits, /, _ or -",
          classification: "permanent",
        });
      }
      names.add(scenario.name);
    }
  });
  return {
    list: validate.pipe(
      Effect.as(scenarios.map(({ name, description }) => ({ name, description }))),
    ),
    prepare: (name, input = {}) =>
      Effect.gen(function* () {
        yield* validate;
        const scenario = scenarios.find((entry) => entry.name === name);
        if (scenario === undefined)
          return yield* new FixtureError({
            reason: "input",
            detail: "Unknown fixture scenario; use fixtures list",
            classification: "permanent",
          });
        const selected = yield* scenario.prepare(input);
        for (const [alias, fixture] of Object.entries(selected)) {
          if (Object.hasOwn(base, alias) && base[alias] !== fixture)
            return yield* new FixtureError({
              reason: "definition",
              detail: "Scenario root alias conflicts with a base fixture",
              classification: "permanent",
            });
        }
        // Base and scenario members both contribute to the catalog's requirement union.
        return mergeRoots(base, selected) as FixtureSet<Requirements<B> | ScenarioRequirements<S>>;
      }),
  };
};
