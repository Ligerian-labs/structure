import type { Principal } from "./principal.js";

/** What a condition sees when a conditional grant is evaluated. */
export interface ConditionContext {
  readonly principal: Principal;
  /**
   * Facts about the resource instance the check concerns (`{ ownerId }`,
   * `{ tenantId, status }`…), passed by the caller as `CheckOptions.attributes`.
   * Empty when the caller passed none — conditions then naturally fail closed.
   */
  readonly attributes: Readonly<Record<string, unknown>>;
  /** The scope named by the check, if any. */
  readonly scope: string | undefined;
}

/**
 * A pure predicate attached to a grant: the permission is held only while the
 * condition is true for the principal/resource at hand (attribute-based
 * refinement of a role grant). Must not throw and must not perform effects;
 * anything that needs I/O belongs in the handler before the check.
 */
export type Condition = (context: ConditionContext) => boolean;

const attributeOf = (context: ConditionContext, key: string): unknown => context.attributes[key];

/** The resource attribute `key` (default `ownerId`) equals the principal's id. */
const owner =
  (key = "ownerId"): Condition =>
  (context) =>
    attributeOf(context, key) === context.principal.id;

/**
 * The resource attribute `key` (default `tenantId`) equals the principal's
 * `tenantId`; false when either side is missing.
 */
const sameTenant =
  (key = "tenantId"): Condition =>
  (context) =>
    context.principal.tenantId !== undefined &&
    attributeOf(context, key) === context.principal.tenantId;

/** The resource attribute `key` is strictly equal to `value`. */
const attributeEquals =
  (key: string, value: unknown): Condition =>
  (context) =>
    attributeOf(context, key) === value;

/** The resource attribute `key` is one of `values`. */
const attributeIn =
  (key: string, values: ReadonlyArray<unknown>): Condition =>
  (context) =>
    values.includes(attributeOf(context, key));

/** The principal attribute `key` is strictly equal to `value`. */
const principalAttributeEquals =
  (key: string, value: unknown): Condition =>
  (context) =>
    context.principal.attributes?.[key] === value;

/** Every condition holds. */
const all =
  (...conditions: ReadonlyArray<Condition>): Condition =>
  (context) =>
    conditions.every((condition) => condition(context));

/** At least one condition holds. */
const any =
  (...conditions: ReadonlyArray<Condition>): Condition =>
  (context) =>
    conditions.some((condition) => condition(context));

/** The condition does not hold. */
const not =
  (condition: Condition): Condition =>
  (context) =>
    !condition(context);

/** Ready-made conditions and combinators for conditional grants. */
export const Condition = {
  owner,
  sameTenant,
  attributeEquals,
  attributeIn,
  principalAttributeEquals,
  all,
  any,
  not,
} as const;
