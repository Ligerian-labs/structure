import { Correlation } from "@structure-ai/observability";
import { Effect, FiberRef, Option } from "effect";
import { globalValue } from "effect/GlobalValue";
import { Unauthenticated } from "./errors.js";

/**
 * A role held only inside one scope (a tenant, an organisation, a project…).
 * Scopes are opaque strings the application chooses, e.g. `"tenant:acme"`;
 * a check that names the same scope activates the assignment.
 */
export interface RoleAssignment {
  readonly role: string;
  readonly scope: string;
}

/**
 * Who is acting. Built by the application once authentication has happened
 * (session, token, API key…) — this package never authenticates. Roles are
 * policy role names; unknown names grant nothing. A plain string role applies
 * everywhere, a {@link RoleAssignment} only inside its scope.
 */
export interface Principal {
  readonly id: string;
  readonly roles: ReadonlyArray<string | RoleAssignment>;
  /** Distinguishes humans, machines and the explicit anonymous principal. */
  readonly kind?: "user" | "service" | "anonymous";
  /** Convenience for tenant-aware conditions (`Condition.sameTenant`). */
  readonly tenantId?: string;
  /** Free-form facts about the principal that conditions may consult. */
  readonly attributes?: Readonly<Record<string, unknown>>;
}

const ref = globalValue("@structure-ai/authorization/Principal", () =>
  FiberRef.unsafeMake<Option.Option<Principal>>(Option.none()),
);

/**
 * The explicit "nobody is signed in" principal. Use it when unauthenticated
 * callers should still be evaluated against the policy (e.g. a `guest` role);
 * when it is denied, the failure is `Unauthenticated`, not `PermissionDenied`.
 */
const anonymous: Principal = { id: "anonymous", roles: [], kind: "anonymous" };

const isAnonymous = (principal: Principal): boolean => principal.kind === "anonymous";

/** Role names of the principal effective in `scope` (global ones always are). */
const rolesIn = (principal: Principal, scope: string | undefined): ReadonlyArray<string> => {
  const out: Array<string> = [];
  for (const assignment of principal.roles) {
    if (typeof assignment === "string") {
      if (!out.includes(assignment)) out.push(assignment);
    } else if (
      scope !== undefined &&
      assignment.scope === scope &&
      !out.includes(assignment.role)
    ) {
      out.push(assignment.role);
    }
  }
  return out;
};

const hasRole = (principal: Principal, role: string, scope?: string): boolean =>
  rolesIn(principal, scope).includes(role);

/** The principal attached to the current fiber, if any. */
const current: Effect.Effect<Option.Option<Principal>> = FiberRef.get(ref);

/** The current principal, or `Unauthenticated` when none (or anonymous) is attached. */
const required: Effect.Effect<Principal, Unauthenticated> = Effect.flatMap(current, (option) =>
  Option.isSome(option) && !isAnonymous(option.value)
    ? Effect.succeed(option.value)
    : Effect.fail(new Unauthenticated({ reason: "no principal attached" })),
);

/**
 * Runs an effect on behalf of a principal: every check below sees it, and
 * the correlation context (logs, spans, CQRS dispatches) carries its id as
 * `actor`. Called by the HTTP middleware; call it yourself for jobs, CLI
 * commands and tests.
 */
const within =
  (principal: Principal) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    effect.pipe(
      Effect.locally(ref, Option.some(principal)),
      Correlation.within({ actor: principal.id }),
    );

/** Runs an effect with no principal attached (e.g. to drop elevated context). */
const withoutPrincipal = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.locally(ref, Option.none<Principal>())(effect);

/** Principal constructors, predicates and fiber-scoped propagation. */
export const Principal = {
  anonymous,
  isAnonymous,
  rolesIn,
  hasRole,
  current,
  required,
  within,
  without: withoutPrincipal,
} as const;
