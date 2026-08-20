import {
  type AnyMessageDefinition,
  type AuthorizationRequest,
  Authorizer,
  Unauthorized,
} from "@structure-ai/cqrs";
import { Effect, Layer, Option, type Schema } from "effect";
import type { CheckOptions, Policy } from "./policy.js";
import { Principal } from "./principal.js";

/** What a message rule resolves to: a permission check, or open access. */
export type Requirement<Permission extends string> =
  | {
      readonly permission: Permission;
      readonly scope?: string;
      readonly attributes?: CheckOptions["attributes"];
    }
  | "public";

/**
 * How to authorize one message: a permission name, `"public"`, or a function
 * of the decoded payload returning either — e.g. to derive the scope from a
 * `tenantId` field or to hand the payload to a conditional grant.
 */
export type MessageRule<Permission extends string, Payload> =
  | Permission
  | "public"
  | ((payload: Payload) => Requirement<Permission>);

export interface CqrsAuthorizationOptions {
  /**
   * What happens to a dispatched message no rule covers. Default `"deny"`:
   * every message must be mapped explicitly, so forgetting one fails closed.
   */
  readonly unmapped?: "deny" | "allow";
  /**
   * Resolves a principal from the dispatch `actor` id when none is attached
   * to the fiber (e.g. dispatches from a job runner that only knows the user
   * id). When both exist, the fiber's principal wins.
   */
  readonly resolvePrincipal?: (actor: string) => Effect.Effect<Option.Option<Principal>>;
}

/** The decoded payload type of a message definition. */
export type PayloadOf<Def extends AnyMessageDefinition> = Schema.Schema.Type<Def["payload"]>;

type ErasedRule = MessageRule<string, unknown>;

const resolveRequirement = (rule: ErasedRule, payload: unknown): Requirement<string> =>
  typeof rule === "function" ? rule(payload) : rule === "public" ? "public" : { permission: rule };

/**
 * Builds the cqrs `Authorizer` from a policy and per-message rules. Rules are
 * keyed by message definition so the payload type flows into rule functions.
 * Terminal: `.layer` is the `Authorizer` layer to provide to the buses in
 * place of `Authorizer.allowAll`.
 *
 * ```ts
 * const AuthorizerLive = CqrsAuthorization.rules(policy)
 *   .message(ApproveInvoice, "invoice:approve")
 *   .message(ReadInvoice, (p) => ({ permission: "invoice:read", scope: `tenant:${p.tenantId}` }))
 *   .public(Healthcheck)
 *   .layer;
 * ```
 */
export class CqrsAuthorizationRules<Permission extends string> {
  private constructor(
    private readonly policy: Policy<Permission, string>,
    private readonly rules: ReadonlyMap<string, ErasedRule>,
    private readonly options: CqrsAuthorizationOptions,
  ) {}

  static make<Permission extends string>(
    policy: Policy<Permission, string>,
    options: CqrsAuthorizationOptions = {},
  ): CqrsAuthorizationRules<Permission> {
    return new CqrsAuthorizationRules(policy, new Map(), options);
  }

  /** Attaches a rule to a message; a second rule for the same tag replaces the first. */
  message<Def extends AnyMessageDefinition>(
    definition: Def,
    rule: MessageRule<Permission, PayloadOf<Def>>,
  ): CqrsAuthorizationRules<Permission> {
    const next = new Map(this.rules);
    // Rule functions only ever receive this definition's decoded payload.
    next.set(definition.tag, rule as ErasedRule);
    return new CqrsAuthorizationRules(this.policy, next, this.options);
  }

  /** Several messages sharing one rule (the rule sees the payload as `unknown`). */
  messages(
    definitions: ReadonlyArray<AnyMessageDefinition>,
    rule: MessageRule<Permission, unknown>,
  ): CqrsAuthorizationRules<Permission> {
    let current: CqrsAuthorizationRules<Permission> = this;
    for (const definition of definitions) current = current.message(definition, rule);
    return current;
  }

  /** Messages anyone may dispatch, authenticated or not. */
  public(...definitions: ReadonlyArray<AnyMessageDefinition>): CqrsAuthorizationRules<Permission> {
    return this.messages(definitions, "public");
  }

  /** Tags with a rule — assert in tests that every registered handler is covered. */
  get tags(): ReadonlyArray<string> {
    return [...this.rules.keys()];
  }

  /** The `authorize` function of the resulting `Authorizer` service. */
  get authorize(): (request: AuthorizationRequest) => Effect.Effect<void, Unauthorized> {
    const { policy, rules, options } = this;
    const unmapped = options.unmapped ?? "deny";
    const deny = (
      request: AuthorizationRequest,
      reason: string,
    ): Effect.Effect<never, Unauthorized> =>
      Effect.fail(
        new Unauthorized({
          tag: request.tag,
          reason,
          ...(request.actor !== undefined && { actor: request.actor }),
        }),
      );
    const principalFor = (request: AuthorizationRequest): Effect.Effect<Option.Option<Principal>> =>
      Effect.flatMap(Principal.current, (attached) =>
        Option.isSome(attached)
          ? Effect.succeed(attached)
          : request.actor !== undefined && options.resolvePrincipal !== undefined
            ? options.resolvePrincipal(request.actor)
            : Effect.succeed(Option.none()),
      );
    return (request) =>
      Effect.gen(function* () {
        const rule = rules.get(request.tag);
        if (rule === undefined) {
          if (unmapped === "allow") return;
          return yield* deny(request, `no authorization rule for "${request.tag}"`);
        }
        const requirement = resolveRequirement(rule, request.payload);
        if (requirement === "public") return;
        const principal = yield* principalFor(request);
        if (Option.isNone(principal)) {
          return yield* deny(request, "unauthenticated: no principal attached");
        }
        // Rules are attached through the typed `message` API, so the permission is one of the policy's.
        const decision = policy.decide(principal.value, requirement.permission as Permission, {
          ...(requirement.scope !== undefined && { scope: requirement.scope }),
          ...(requirement.attributes !== undefined && { attributes: requirement.attributes }),
        });
        if (decision.allowed) return;
        return yield* deny(
          request,
          Principal.isAnonymous(principal.value)
            ? `unauthenticated: ${decision.reason}`
            : decision.reason,
        );
      });
  }

  /** The cqrs `Authorizer` layer. */
  get layer(): Layer.Layer<Authorizer> {
    return Layer.succeed(Authorizer, { authorize: this.authorize });
  }
}

/** CQRS bridge: map messages to permissions, get the bus `Authorizer` layer. */
export const CqrsAuthorization = {
  rules: CqrsAuthorizationRules.make,
} as const;
