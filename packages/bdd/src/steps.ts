import type { Expression } from "@cucumber/cucumber-expressions";
import { ExpressionFactory, ParameterTypeRegistry } from "@cucumber/cucumber-expressions";
import type { Effect } from "effect";
import type { DataTable } from "./tables.js";

/** The three gherkin step kinds. Matching is kind-agnostic (cucumber semantics). */
export type StepKind = "given" | "when" | "then";

/**
 * Maps a cucumber-expression parameter name to its TypeScript type. Custom
 * parameter names (`{villa}`, `{}`) are strings — parse richer values in the
 * handler or register a transform upstream.
 */
type ParamOf<Name extends string> = Name extends
  | "int"
  | "float"
  | "double"
  | "byte"
  | "short"
  | "long"
  ? number
  : Name extends "bigint"
    ? bigint
    : string;

/**
 * Derives the parameter tuple of an expression literal: every `{name}` in the
 * expression contributes one parameter. Escaped braces (`{{`) are not
 * distinguished — keep step text brace-free.
 */
export type ExpressionParams<S extends string> = S extends `${string}{${infer Name}}${infer Rest}`
  ? readonly [ParamOf<Name>, ...ExpressionParams<Rest>]
  : readonly [];

/** What a step handler receives. */
export interface StepContext<W, P extends ReadonlyArray<unknown>> {
  /** The per-scenario world. */
  readonly world: W;
  /** Matched cucumber-expression parameters, in order. */
  readonly params: P;
  /** The step's data table, when it has one. */
  readonly table?: DataTable;
  /** The step's doc string, when it has one. */
  readonly doc?: string;
}

/** What a step handler may return. */
export type StepResult<R> = Effect.Effect<void, unknown, R> | Promise<void> | void;

/**
 * A step handler as written at the definition site, with parameters typed
 * from the expression literal.
 */
export type StepHandler<W, P extends ReadonlyArray<unknown>, R> = (
  ctx: StepContext<W, P>,
) => StepResult<R>;

/**
 * A registered step definition. The parameter tuple lives only in the
 * definition-site signature ({@link Given}/{@link When}/{@link Then}); the
 * stored handler is parameter-erased — the matcher guarantees it is only
 * ever invoked with parameters that matched the expression.
 */
export interface StepDefinition<W, R = never> {
  readonly _tag: "StepDefinition";
  readonly expressionText: string;
  readonly kinds: ReadonlyArray<StepKind>;
  readonly handler: (ctx: StepContext<W, ReadonlyArray<unknown>>) => StepResult<R>;
}

const parameterTypes = new ParameterTypeRegistry();
const expressions = new ExpressionFactory(parameterTypes);

/** Compiles an expression text into a matcher (cached by the factory). */
export const compileExpression = (text: string): Expression => expressions.createExpression(text);

const defineStep =
  (kinds: ReadonlyArray<StepKind>) =>
  /**
   * Registers a step. The handler's `params` are typed from the expression
   * literal: `{string}` → `string`, `{int}`/`{float}` → `number`, `{bigint}`
   * → `bigint`, anything else → `string`.
   */
  <S extends string, W, R = never>(
    expression: S,
    handler: StepHandler<W, ExpressionParams<S>, R>,
  ): StepDefinition<W, R> => ({
    _tag: "StepDefinition",
    expressionText: expression,
    kinds,
    handler: handler as unknown as StepDefinition<W, R>["handler"],
  });

/** Registers a `Given` step definition. */
export const Given = defineStep(["given"]);
/** Registers a `When` step definition. */
export const When = defineStep(["when"]);
/** Registers a `Then` step definition. */
export const Then = defineStep(["then"]);
