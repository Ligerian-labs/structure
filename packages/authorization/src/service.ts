import { Context, Effect, Layer } from "effect";
import type { PermissionDenied, Unauthenticated } from "./errors.js";
import type { CheckOptions, Decision, Guard, Policy } from "./policy.js";
import { Principal } from "./principal.js";

/**
 * The policy as an Effect service, for code that should not import the
 * policy module directly (shared handlers, library code, tests that swap the
 * policy). Permissions are plain strings here; typing lives on the `Policy`
 * value. A permission the policy does not declare is a wiring bug and dies.
 */
export interface AuthorizationService {
  readonly policy: Policy;
  /** Decision for the fiber's principal; anonymous when none is attached. */
  readonly decide: (permission: string, options?: CheckOptions) => Effect.Effect<Decision>;
  readonly can: (permission: string, options?: CheckOptions) => Effect.Effect<boolean>;
  readonly check: (
    permission: string,
    options?: CheckOptions,
  ) => Effect.Effect<void, PermissionDenied | Unauthenticated>;
  readonly require: (permission: string, options?: CheckOptions) => Guard;
  readonly requireRole: (role: string, options?: { readonly scope?: string }) => Guard;
}

const assertKnown = (policy: Policy, permission: string): Effect.Effect<void> =>
  policy.isPermission(permission)
    ? Effect.void
    : Effect.dieMessage(`permission "${permission}" is not declared by the policy`);

const makeService = (policy: Policy): AuthorizationService => {
  const decide = (permission: string, options?: CheckOptions): Effect.Effect<Decision> =>
    Effect.zipRight(
      assertKnown(policy, permission),
      Effect.map(Principal.current, (option) =>
        policy.decide(
          option._tag === "Some" ? option.value : Principal.anonymous,
          permission,
          options,
        ),
      ),
    );
  return {
    policy,
    decide,
    can: (permission, options) => Effect.map(decide(permission, options), (d) => d.allowed),
    check: (permission, options) =>
      Effect.zipRight(assertKnown(policy, permission), policy.check(permission, options)),
    require: (permission, options) => (effect) =>
      Effect.zipRight(assertKnown(policy, permission), policy.require(permission, options)(effect)),
    requireRole: (role, options) => policy.requireRole(role, options),
  };
};

/** Authorization as a service: provide `Authorization.layer(policy)` once, use the static accessors anywhere. */
export class Authorization extends Context.Tag("@structure-ai/authorization/Authorization")<
  Authorization,
  AuthorizationService
>() {
  static readonly make = (policy: Policy): AuthorizationService => makeService(policy);

  static readonly layer = (policy: Policy): Layer.Layer<Authorization> =>
    Layer.succeed(Authorization, makeService(policy));

  static readonly decide = (
    permission: string,
    options?: CheckOptions,
  ): Effect.Effect<Decision, never, Authorization> =>
    Effect.flatMap(Authorization, (service) => service.decide(permission, options));

  static readonly can = (
    permission: string,
    options?: CheckOptions,
  ): Effect.Effect<boolean, never, Authorization> =>
    Effect.flatMap(Authorization, (service) => service.can(permission, options));

  static readonly check = (
    permission: string,
    options?: CheckOptions,
  ): Effect.Effect<void, PermissionDenied | Unauthenticated, Authorization> =>
    Effect.flatMap(Authorization, (service) => service.check(permission, options));

  /** Guard requiring the service: `handler.pipe(Authorization.require("invoice:approve"))`. */
  static readonly require =
    (permission: string, options?: CheckOptions) =>
    <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | PermissionDenied | Unauthenticated, R | Authorization> =>
      Effect.flatMap(Authorization, (service) => service.require(permission, options)(effect));

  static readonly requireRole =
    (role: string, options?: { readonly scope?: string }) =>
    <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | PermissionDenied | Unauthenticated, R | Authorization> =>
      Effect.flatMap(Authorization, (service) => service.requireRole(role, options)(effect));

  /** The fiber's principal or `Unauthenticated` — re-exported here for discoverability. */
  static readonly principal: Effect.Effect<Principal, Unauthenticated> = Principal.required;
}
