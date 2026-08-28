import { describe, test } from "bun:test";
import { readFileSync } from "node:fs";
import { generateMessages } from "@cucumber/gherkin";
import type {
  Background,
  FeatureChild,
  DataTable as GherkinDataTable,
  GherkinDocument,
  Pickle,
  PickleStepArgument,
  Rule,
  Scenario,
  SourceMediaType,
  Step,
  TableRow,
} from "@cucumber/messages";
import { Effect, type Scope as ScopeType } from "effect";
import { compileExpression, type StepDefinition, type StepKind } from "./steps.js";
import { type DataTable, dataTableFromCells } from "./tables.js";
import type { ScenarioWorld } from "./world.js";

/** One parsed feature with its compiled scenarios (pickles). */
interface Feature {
  readonly name: string;
  readonly file: string;
  readonly scenarios: ReadonlyArray<FeatureScenario>;
}

interface FeatureStep {
  readonly text: string;
  readonly kind: StepKind;
  readonly line: number;
  readonly table?: DataTable;
  readonly doc?: string;
}

interface FeatureScenario {
  readonly name: string;
  readonly tags: ReadonlyArray<string>;
  readonly steps: ReadonlyArray<FeatureStep>;
}

/** Options for {@link defineFeatureSuite}. */
export interface FeatureSuiteOptions<W extends ScenarioWorld<R>, R> {
  /**
   * Glob(s) of `.feature` files, resolved from the package root (where
   * `bun test` runs) — cover every feature file of the suite.
   */
  readonly features: string | ReadonlyArray<string>;
  /**
   * Builds a fresh world per scenario inside the suite-owned scope: wire the
   * app composition (in-memory adapters, doubles, buses) exactly like a
   * `serveTest` stack, but with every durable port doubled.
   */
  readonly makeWorld: (scope: ScopeType.Scope) => Effect.Effect<W, never, never>;
  /** The step definitions available to every feature. */
  readonly steps: ReadonlyArray<StepDefinition<W, R>>;
  /**
   * Drains async work (outbox relay, projection catch-up) so `Then` steps
   * observe converged state. Runs after every step by default — eventual
   * consistency is the framework's problem, not the scenario's.
   */
  readonly drain?: (world: W) => Effect.Effect<void, unknown, R>;
  /** Set `false` to run {@link FeatureSuiteOptions.drain} manually from steps. Default: `true`. */
  readonly drainAfterStep?: boolean;
}

const kindOf = (pickleStepType: string): StepKind =>
  pickleStepType === "Action" ? "when" : pickleStepType === "Outcome" ? "then" : "given";

const mediaType: SourceMediaType = "text/x.cucumber.gherkin+plain" as SourceMediaType;

const stepArgument = (
  argument: PickleStepArgument | undefined,
): { readonly table?: DataTable; readonly doc?: string } => {
  if (argument?.dataTable !== undefined) {
    return {
      table: dataTableFromCells(
        (argument.dataTable.rows ?? []).map((row) => ({
          cells: (row.cells ?? []).map((cell) => ({ value: cell.value ?? "" })),
        })),
      ),
    };
  }
  if (argument?.docString !== undefined) return { doc: argument.docString.content ?? "" };
  return {};
};

/** Maps AST node ids to source lines for failure and wiring reports. */
const stepLines = (document: GherkinDocument): Map<string, number> => {
  const lines = new Map<string, number>();
  const scenarioSteps = (scenario: Scenario): void => {
    for (const step of scenario.steps) lines.set(step.id, step.location.line);
    for (const examples of scenario.examples) {
      for (const row of examples.tableBody) lines.set(row.id, row.location.line);
    }
  };
  const backgroundSteps = (background: Background): void => {
    for (const step of background.steps) lines.set(step.id, step.location.line);
  };
  const children = (list: ReadonlyArray<FeatureChild>): void => {
    for (const child of list) {
      if (child.scenario !== undefined) scenarioSteps(child.scenario);
      if (child.background !== undefined) backgroundSteps(child.background);
    }
  };
  const rules = (list: ReadonlyArray<FeatureChild>): void => {
    for (const child of list) {
      if (child.rule !== undefined) rules(child.rule.children);
    }
  };
  const feature = document.feature;
  if (feature !== undefined) {
    children(feature.children);
    rules(feature.children);
  }
  return lines;
};

// Keep gherkin AST table types referenced (argument extraction works on the
// pickle side; these imports document the shapes involved).
export type GherkinTable = GherkinDataTable;
export type GherkinRow = TableRow;
export type GherkinStep = Step;
export type GherkinRule = Rule;

export const parseFeatures = (patterns: string | ReadonlyArray<string>): ReadonlyArray<Feature> => {
  const files = [
    ...new Set(
      (typeof patterns === "string" ? [patterns] : [...patterns]).flatMap((pattern) => [
        ...new Bun.Glob(pattern).scanSync({ cwd: process.cwd() }),
      ]),
    ),
  ].sort();
  if (files.length === 0) {
    throw new Error(`no .feature files match: ${JSON.stringify(patterns)}`);
  }

  const features: Array<Feature> = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const envelopes = generateMessages(source, file, mediaType, {
      includeSource: false,
      includeGherkinDocument: true,
      includePickles: true,
      newId: () => `bdd-${features.length}-${Math.random().toString(36).slice(2)}`,
    });

    const document = envelopes.find((e) => e.gherkinDocument !== undefined)?.gherkinDocument;
    if (document === undefined || document.feature === undefined) continue;
    const lines = stepLines(document);

    features.push({
      name: document.feature.name ?? file,
      file,
      scenarios: envelopes
        .flatMap((e) => (e.pickle !== undefined ? [e.pickle] : []))
        .map((pickle) => toScenario(pickle, lines)),
    });
  }
  return features;
};

const toScenario = (pickle: Pickle, lines: Map<string, number>): FeatureScenario => ({
  name: pickle.name ?? "",
  tags: (pickle.tags ?? []).map((tag) => tag.name ?? ""),
  steps: (pickle.steps ?? []).map((step) => ({
    text: step.text,
    kind: kindOf(step.type ?? "Unknown"),
    line: lines.get(step.astNodeIds?.[0] ?? "") ?? 0,
    ...stepArgument(step.argument),
  })),
});

interface MatchedStep<W, R> {
  readonly definition: StepDefinition<W, R>;
  readonly params: ReadonlyArray<unknown>;
}

const matchStep = <W, R>(
  definitions: ReadonlyArray<StepDefinition<W, R>>,
  text: string,
): ReadonlyArray<MatchedStep<W, R>> => {
  const matches: Array<MatchedStep<W, R>> = [];
  for (const definition of definitions) {
    const match = compileExpression(definition.expressionText).match(text);
    if (match !== null) {
      matches.push({
        definition,
        params: match.map((argument) => argument.getValue<unknown>(undefined)),
      });
    }
  }
  return matches;
};

export const checkWiring = <W, R>(
  features: ReadonlyArray<Feature>,
  definitions: ReadonlyArray<StepDefinition<W, R>>,
): void => {
  const problems: Array<string> = [];
  for (const feature of features) {
    for (const scenario of feature.scenarios) {
      // WIP scenarios reference steps that do not exist yet, on purpose.
      if (scenario.tags.some((tag) => tag === "@wip")) continue;
      for (const step of scenario.steps) {
        const matches = matchStep(definitions, step.text);
        if (matches.length === 0) {
          problems.push(
            `undefined step — ${feature.file}:${step.line} — "${step.text}" has no matching definition`,
          );
        } else if (matches.length > 1) {
          problems.push(
            `ambiguous step — ${feature.file}:${step.line} — "${step.text}" matches ${matches.length} definitions: ${matches
              .map((m) => JSON.stringify(m.definition.expressionText))
              .join(", ")}`,
          );
        }
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `feature suite wiring is broken (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n${problems
        .map((problem) => `  - ${problem}`)
        .join("\n")}`,
    );
  }
};

const isEffect = (value: unknown): value is Effect.Effect<unknown, unknown, unknown> =>
  Effect.isEffect(value);

const isPromiseLike = (value: unknown): value is PromiseLike<void> =>
  typeof value === "object" &&
  value !== null &&
  "then" in value &&
  typeof (value as { then: unknown }).then === "function";

const stepFailed = (file: string, step: FeatureStep, cause: unknown): Error =>
  new Error(`${file}:${step.line} — "${step.text}" failed`, { cause });

const runStep = <W extends ScenarioWorld<R>, R>(
  world: W,
  matched: MatchedStep<W, R>,
  step: FeatureStep,
): Effect.Effect<void, unknown, never> =>
  Effect.suspend(() => {
    const result: unknown = matched.definition.handler({
      world,
      params: matched.params as never,
      ...(step.table !== undefined && { table: step.table }),
      ...(step.doc !== undefined && { doc: step.doc }),
    });
    if (isEffect(result)) {
      return world.use(result as Effect.Effect<void, unknown, R>);
    }
    if (isPromiseLike(result)) {
      return Effect.promise(() => result);
    }
    return Effect.void;
  });

/**
 * Defines the feature suite of a package: compiles `.feature` files into
 * ordinary `bun test` cases. Call it once from a `*.test.ts` file; scenarios
 * become tests named after the feature and scenario (tags included, so
 * `bun test --test-name-pattern "@booking"` filters by tag). Suites with
 * undefined or ambiguous steps fail at load time with a full report, and
 * scenarios tagged `@wip` are registered as todo.
 *
 * ```ts
 * // test/features.test.ts
 * import { defineFeatureSuite } from "@structure-ai/bdd";
 *
 * defineFeatureSuite({
 *   features: a glob matching the package's .feature files,
 *   makeWorld: (scope) => buildTestWorld(scope),
 *   steps: [bookingSteps, customerSteps],
 *   drain: (world) => world.use(runWorkersOnce),
 * });
 * ```
 */
export const defineFeatureSuite = <W extends ScenarioWorld<R>, R>(
  options: FeatureSuiteOptions<W, R>,
): void => {
  const features = parseFeatures(options.features);
  checkWiring(features, options.steps);
  const drainAfterStep = options.drain !== undefined && (options.drainAfterStep ?? true);

  for (const feature of features) {
    describe(feature.name, () => {
      for (const scenario of feature.scenarios) {
        const name = [...scenario.tags, scenario.name].join(" ").trim();
        if (scenario.tags.some((tag) => tag === "@wip")) {
          test.todo(name, () => {});
          continue;
        }
        test(name, async () => {
          // `Effect.scoped` owns the scenario scope: the world builds inside
          // it and its finalizers (stores, buses, doubles) run when the
          // scenario ends — success or failure.
          await Effect.runPromise(
            Effect.scoped(
              Effect.gen(function* () {
                const world = yield* options.makeWorld(yield* Effect.scope);
                for (const step of scenario.steps) {
                  const match = matchStep(options.steps, step.text);
                  yield* runStep(world, match[0] as MatchedStep<W, R>, step).pipe(
                    Effect.mapError((error) => stepFailed(feature.file, step, error)),
                    Effect.catchAllDefect((defect) =>
                      Effect.fail(stepFailed(feature.file, step, defect)),
                    ),
                  );
                  if (drainAfterStep) {
                    const drain = options.drain?.(world);
                    if (drain !== undefined) {
                      yield* world
                        .use(drain)
                        .pipe(Effect.mapError((error) => stepFailed(feature.file, step, error)));
                    }
                  }
                }
              }),
            ),
          );
        });
      }
    });
  }
};
