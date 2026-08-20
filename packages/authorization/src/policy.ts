import { Effect, Either, Schema } from "effect";
import { ArrayFormatter, type ParseError } from "effect/ParseResult";
import type { Condition, ConditionContext } from "./condition.js";
import { InvalidPolicy, PermissionDenied, Unauthenticated } from "./errors.js";
import { Principal } from "./principal.js";

// --- definition types ----------------------------------------------------------

/** Resources and the actions each one supports: `{ invoice: ["read", "approve"] }`. */
export type ResourceDefinitions = Readonly<Record<string, ReadonlyArray<string>>>;

/** The `resource:action` permission union derived from resource definitions. */
export type ResourcePermission<Resources extends ResourceDefinitions> = {
  readonly [R in keyof Resources & string]: `${R}:${Resources[R][number]}`;
}[keyof Resources & string];

/** What a role may be granted: a permission, every action of one resource, or everything. */
export type ResourceGrant<Resources extends ResourceDefinitions> =
  | ResourcePermission<Resources>
  | `${keyof Resources & string}:*`
  | "*";

/** A grant that only holds while the named condition is true. */
export interface ConditionalGrant<
  Grant extends string = string,
  ConditionName extends string = string,
> {
  readonly permission: Grant;
  readonly when: ConditionName;
}

export type Grant<G extends string = string, ConditionName extends string = string> =
  | G
  | ConditionalGrant<G, ConditionName>;

/**
 * One role: what it is granted directly plus the roles it inherits from.
 * Inheritance is transitive; a permission granted unconditionally anywhere
 * along the chain wins over a conditional grant of the same permission.
 */
export interface RoleDefinition<
  G extends string = string,
  Role extends string = string,
  ConditionName extends string = string,
> {
  readonly description?: string;
  readonly inherits?: ReadonlyArray<Role>;
  readonly grants?: ReadonlyArray<Grant<G, ConditionName>>;
}

/**
 * The serializable form of a policy: everything but the condition functions,
 * which are referenced by name. Loadable from JSON/config via
 * {@link PolicyDefinitionSchema} and `Policy.decode`.
 */
export interface PolicyDefinition {
  readonly resources: ResourceDefinitions;
  readonly roles: Readonly<Record<string, RoleDefinition>>;
}

/** Schema of {@link PolicyDefinition} (shape only; consistency is checked by `Policy.make`). */
export const PolicyDefinitionSchema = Schema.Struct({
  resources: Schema.Record({ key: Schema.String, value: Schema.Array(Schema.String) }),
  roles: Schema.Record({
    key: Schema.String,
    value: Schema.Struct({
      description: Schema.optionalWith(Schema.String, { exact: true }),
      inherits: Schema.optionalWith(Schema.Array(Schema.String), { exact: true }),
      grants: Schema.optionalWith(
        Schema.Array(
          Schema.Union(
            Schema.String,
            Schema.Struct({ permission: Schema.String, when: Schema.String }),
          ),
        ),
        { exact: true },
      ),
    }),
  }),
});

// --- evaluation types ----------------------------------------------------------

/** A permission a role ends up holding, after wildcard expansion and inheritance. */
export interface ResolvedGrant<Permission extends string = string> {
  readonly permission: Permission;
  /** Empty when unconditional; otherwise any one listed condition suffices. */
  readonly conditions: ReadonlyArray<string>;
}

/** Per-check inputs. */
export interface CheckOptions {
  /** Activates the principal's role assignments scoped to exactly this value. */
  readonly scope?: string;
  /** Facts about the resource instance, consulted by conditional grants. */
  readonly attributes?: Readonly<Record<string, unknown>>;
}

/** The outcome of one check, with an explanation for logs and audit. */
export interface Decision {
  readonly allowed: boolean;
  readonly permission: string;
  readonly principal: string;
  readonly scope?: string;
  /** Role whose grant allowed the action. */
  readonly role?: string;
  /** Condition under which the grant held, when the grant was conditional. */
  readonly condition?: string;
  readonly reason: string;
}

export type MatrixCell =
  | { readonly kind: "granted" }
  | { readonly kind: "conditional"; readonly conditions: ReadonlyArray<string> }
  | { readonly kind: "denied" };

/** The fully resolved role × permission table. */
export interface PolicyMatrix<Permission extends string = string, Role extends string = string> {
  readonly permissions: ReadonlyArray<Permission>;
  readonly roles: ReadonlyArray<Role>;
  readonly cells: { readonly [R in Role]: { readonly [P in Permission]: MatrixCell } };
}

/** Wraps an effect so it only runs when a check passes. */
export type Guard = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E | PermissionDenied | Unauthenticated, R>;

/**
 * A validated, resolved policy: the typed permission vocabulary, pure
 * decisions for any principal, and Effect checks/guards for the principal
 * attached to the current fiber (`Principal.within`).
 */
export interface Policy<Permission extends string = string, Role extends string = string> {
  readonly definition: PolicyDefinition;
  readonly resources: ResourceDefinitions;
  readonly roles: ReadonlyArray<Role>;
  /** Every `resource:action` permission, in definition order. */
  readonly permissions: ReadonlyArray<Permission>;
  readonly isPermission: (value: string) => value is Permission;
  readonly isRole: (value: string) => value is Role;
  // Methods (not function properties) on purpose: method parameters are
  // bivariant, so a precisely typed `Policy<"a:b", "admin">` remains
  // assignable to the erased `Policy` the service and bridges accept.
  /** What `role` holds once wildcards and inheritance are resolved. */
  grantsOf(role: Role): ReadonlyArray<ResolvedGrant<Permission>>;
  /** Pure decision for an explicit principal. Never throws for unknown roles or permissions: they deny. */
  decide(principal: Principal, permission: Permission, options?: CheckOptions): Decision;
  can(principal: Principal, permission: Permission, options?: CheckOptions): boolean;
  /**
   * Checks the fiber's principal: `Unauthenticated` when none (or the
   * anonymous one) is attached and the permission is not granted,
   * `PermissionDenied` when a known principal lacks it.
   */
  check(
    permission: Permission,
    options?: CheckOptions,
  ): Effect.Effect<void, PermissionDenied | Unauthenticated>;
  /** `check` as a wrapper: the effect runs only when the check passes. */
  require(permission: Permission, options?: CheckOptions): Guard;
  /** Requires the fiber's principal to hold `role` (globally, or in `scope`). */
  requireRole(role: Role, options?: { readonly scope?: string }): Guard;
  matrix(): PolicyMatrix<Permission, Role>;
  /** The matrix as a markdown table — paste it in docs, hand it to agents. */
  toMarkdown(): string;
}

/** The permission union of a policy value: `type Permission = PolicyPermission<typeof policy>`. */
export type PolicyPermission<P> =
  P extends Policy<infer Permission, infer _Role> ? Permission : never;

/** The role union of a policy value. */
export type PolicyRole<P> = P extends Policy<infer _Permission, infer Role> ? Role : never;

// --- implementation --------------------------------------------------------------

type ConditionMap = Readonly<Record<string, Condition>>;

/** `null` marks an unconditional grant; a set lists the alternatives. */
type ResolvedRole = ReadonlyMap<string, ReadonlySet<string> | null>;

const malformedName = (name: string): boolean =>
  name.length === 0 || name.includes(":") || name.includes("*") || name.trim() !== name;

const validate = (
  definition: PolicyDefinition,
  conditions: ConditionMap,
): ReadonlyArray<string> => {
  const issues: Array<string> = [];
  const permissions = new Set<string>();

  for (const [resource, actions] of Object.entries(definition.resources)) {
    if (malformedName(resource)) {
      issues.push(`resource "${resource}": name must be non-empty, without ":" or "*"`);
    }
    if (actions.length === 0) issues.push(`resource "${resource}": declares no action`);
    const seen = new Set<string>();
    for (const action of actions) {
      if (malformedName(action)) {
        issues.push(
          `resource "${resource}": action "${action}" must be non-empty, without ":" or "*"`,
        );
      }
      if (seen.has(action)) issues.push(`resource "${resource}": duplicate action "${action}"`);
      seen.add(action);
      permissions.add(`${resource}:${action}`);
    }
  }

  const roleNames = Object.keys(definition.roles);
  for (const [role, spec] of Object.entries(definition.roles)) {
    if (role.length === 0 || role.trim() !== role) {
      issues.push(`role "${role}": name must be non-empty without surrounding whitespace`);
    }
    for (const parent of spec.inherits ?? []) {
      if (!roleNames.includes(parent))
        issues.push(`role "${role}": inherits unknown role "${parent}"`);
    }
    for (const grant of spec.grants ?? []) {
      const permission = typeof grant === "string" ? grant : grant.permission;
      if (permission !== "*") {
        if (permission.endsWith(":*")) {
          const resource = permission.slice(0, -2);
          if (!(resource in definition.resources)) {
            issues.push(
              `role "${role}": grant "${permission}" names unknown resource "${resource}"`,
            );
          }
        } else if (!permissions.has(permission)) {
          issues.push(`role "${role}": grant "${permission}" is not a declared permission`);
        }
      }
      if (typeof grant !== "string" && !(grant.when in conditions)) {
        issues.push(
          `role "${role}": grant "${permission}" references unknown condition "${grant.when}"`,
        );
      }
    }
  }

  // Inheritance cycles: report each cycle once, from its first role.
  const state = new Map<string, "visiting" | "done">();
  const visit = (role: string, path: ReadonlyArray<string>): void => {
    const status = state.get(role);
    if (status === "done") return;
    if (status === "visiting") {
      const start = path.indexOf(role);
      issues.push(`inheritance cycle: ${[...path.slice(start), role].join(" -> ")}`);
      return;
    }
    state.set(role, "visiting");
    for (const parent of definition.roles[role]?.inherits ?? []) {
      if (parent in definition.roles) visit(parent, [...path, role]);
    }
    state.set(role, "done");
  };
  for (const role of roleNames) visit(role, []);

  return issues;
};

const expandGrant = (
  permission: string,
  definition: PolicyDefinition,
  all: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  if (permission === "*") return all;
  if (permission.endsWith(":*")) {
    const resource = permission.slice(0, -2);
    return (definition.resources[resource] ?? []).map((action) => `${resource}:${action}`);
  }
  return [permission];
};

const resolveRoles = (
  definition: PolicyDefinition,
  all: ReadonlyArray<string>,
): ReadonlyMap<string, ResolvedRole> => {
  const resolved = new Map<string, ResolvedRole>();
  const merge = (into: Map<string, Set<string> | null>, permission: string, condition?: string) => {
    const existing = into.get(permission);
    if (existing === null) return;
    if (condition === undefined) {
      into.set(permission, null);
      return;
    }
    if (existing === undefined) into.set(permission, new Set([condition]));
    else existing.add(condition);
  };
  const resolve = (role: string): ResolvedRole => {
    const cached = resolved.get(role);
    if (cached !== undefined) return cached;
    const spec = definition.roles[role];
    const own = new Map<string, Set<string> | null>();
    // Validation already rejected cycles, so recursion terminates.
    for (const parent of spec?.inherits ?? []) {
      for (const [permission, conditions] of resolve(parent)) {
        if (conditions === null) merge(own, permission);
        else for (const condition of conditions) merge(own, permission, condition);
      }
    }
    for (const grant of spec?.grants ?? []) {
      const permission = typeof grant === "string" ? grant : grant.permission;
      const condition = typeof grant === "string" ? undefined : grant.when;
      for (const expanded of expandGrant(permission, definition, all)) {
        merge(own, expanded, condition);
      }
    }
    resolved.set(role, own);
    return own;
  };
  for (const role of Object.keys(definition.roles)) resolve(role);
  return resolved;
};

const decisionKey = (options: CheckOptions | undefined): { readonly scope?: string } =>
  options?.scope === undefined ? {} : { scope: options.scope };

const build = (definition: PolicyDefinition, conditions: ConditionMap): Policy => {
  const permissions: ReadonlyArray<string> = Object.entries(definition.resources).flatMap(
    ([resource, actions]) => actions.map((action) => `${resource}:${action}`),
  );
  const permissionSet = new Set(permissions);
  const roles = Object.keys(definition.roles);
  const resolved = resolveRoles(definition, permissions);

  const isPermission = (value: string): value is string => permissionSet.has(value);
  const isRole = (value: string): value is string => value in definition.roles;

  const grantsOf = (role: string): ReadonlyArray<ResolvedGrant> => {
    const entries = resolved.get(role);
    if (entries === undefined) return [];
    return permissions.flatMap((permission) => {
      const entry = entries.get(permission);
      if (entry === undefined) return [];
      return [{ permission, conditions: entry === null ? [] : [...entry].sort() }];
    });
  };

  const decide = (principal: Principal, permission: string, options?: CheckOptions): Decision => {
    const base = { permission, principal: principal.id, ...decisionKey(options) };
    if (!permissionSet.has(permission)) {
      return { ...base, allowed: false, reason: `unknown permission "${permission}"` };
    }
    const held = Principal.rolesIn(principal, options?.scope);
    const known = held.filter(isRole);
    if (known.length === 0) {
      const where = options?.scope === undefined ? "" : ` in scope "${options.scope}"`;
      return {
        ...base,
        allowed: false,
        reason:
          held.length === 0
            ? `principal holds no role${where}`
            : `none of the roles [${held.join(", ")}] is defined in the policy`,
      };
    }
    const context: ConditionContext = {
      principal,
      attributes: options?.attributes ?? {},
      scope: options?.scope,
    };
    const unmet: Array<string> = [];
    for (const role of known) {
      const entry = resolved.get(role)?.get(permission);
      if (entry === undefined) continue;
      if (entry === null) {
        return { ...base, allowed: true, role, reason: `granted by role "${role}"` };
      }
      for (const name of entry) {
        const condition = conditions[name];
        if (condition?.(context)) {
          return {
            ...base,
            allowed: true,
            role,
            condition: name,
            reason: `granted by role "${role}" under condition "${name}"`,
          };
        }
      }
      unmet.push(`${role} (${[...entry].sort().join(" | ")})`);
    }
    return {
      ...base,
      allowed: false,
      reason:
        unmet.length > 0
          ? `conditional grant(s) not met: ${unmet.join(", ")}`
          : `no role of [${known.join(", ")}] grants "${permission}"`,
    };
  };

  const can = (principal: Principal, permission: string, options?: CheckOptions): boolean =>
    decide(principal, permission, options).allowed;

  const check = (
    permission: string,
    options?: CheckOptions,
  ): Effect.Effect<void, PermissionDenied | Unauthenticated> =>
    Effect.flatMap(
      Principal.current,
      (option): Effect.Effect<void, PermissionDenied | Unauthenticated> => {
        if (option._tag === "None") {
          return Effect.fail(new Unauthenticated({ permission, reason: "no principal attached" }));
        }
        const principal = option.value;
        const decision = decide(principal, permission, options);
        if (decision.allowed) return Effect.void;
        if (Principal.isAnonymous(principal)) {
          return Effect.fail(new Unauthenticated({ permission, reason: decision.reason }));
        }
        return Effect.fail(
          new PermissionDenied({
            permission,
            principal: principal.id,
            reason: decision.reason,
            ...decisionKey(options),
          }),
        );
      },
    );

  const require =
    (permission: string, options?: CheckOptions): Guard =>
    (effect) =>
      Effect.zipRight(check(permission, options), effect);

  const requireRole =
    (role: string, options?: { readonly scope?: string }): Guard =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(
        Principal.current,
        (option): Effect.Effect<A, E | PermissionDenied | Unauthenticated, R> => {
          const permission = `role:${role}`;
          if (option._tag === "None") {
            return Effect.fail(
              new Unauthenticated({ permission, reason: "no principal attached" }),
            );
          }
          const principal = option.value;
          if (Principal.hasRole(principal, role, options?.scope)) return effect;
          const reason = `role "${role}" required`;
          if (Principal.isAnonymous(principal)) {
            return Effect.fail(new Unauthenticated({ permission, reason }));
          }
          return Effect.fail(
            new PermissionDenied({
              permission,
              principal: principal.id,
              reason,
              ...decisionKey(options),
            }),
          );
        },
      );

  const matrix = (): PolicyMatrix => {
    const cells: Record<string, Record<string, MatrixCell>> = {};
    for (const role of roles) {
      const row: Record<string, MatrixCell> = {};
      const entries = resolved.get(role);
      for (const permission of permissions) {
        const entry = entries?.get(permission);
        row[permission] =
          entry === undefined
            ? { kind: "denied" }
            : entry === null
              ? { kind: "granted" }
              : { kind: "conditional", conditions: [...entry].sort() };
      }
      cells[role] = row;
    }
    return { permissions, roles, cells };
  };

  const toMarkdown = (): string => {
    const table = matrix();
    const header = `| Permission | ${table.roles.join(" | ")} |`;
    const separator = `| --- | ${table.roles.map(() => "---").join(" | ")} |`;
    const rows = table.permissions.map((permission) => {
      const marks = table.roles.map((role) => {
        const cell = table.cells[role]?.[permission] ?? { kind: "denied" };
        if (cell.kind === "granted") return "✓";
        if (cell.kind === "conditional") return `✓ (${cell.conditions.join(" | ")})`;
        return "·";
      });
      return `| \`${permission}\` | ${marks.join(" | ")} |`;
    });
    return [header, separator, ...rows].join("\n");
  };

  return {
    definition,
    resources: definition.resources,
    roles,
    permissions,
    isPermission,
    isRole,
    grantsOf,
    decide,
    can,
    check,
    require,
    requireRole,
    matrix,
    toMarkdown,
  };
};

/**
 * Validates and resolves a definition. Every inconsistency is reported at
 * once in `InvalidPolicy`. Use this for policies loaded at runtime; use
 * `Policy.define` for the typed, static form.
 */
const make = (
  definition: PolicyDefinition,
  conditions: ConditionMap = {},
): Either.Either<Policy, InvalidPolicy> => {
  const issues = validate(definition, conditions);
  return issues.length > 0
    ? Either.left(new InvalidPolicy({ issues }))
    : Either.right(build(definition, conditions));
};

const formatIssues = (error: ParseError): ReadonlyArray<string> =>
  ArrayFormatter.formatErrorSync(error).map((issue) =>
    issue.path.length === 0 ? issue.message : `${issue.path.join(".")}: ${issue.message}`,
  );

/** Decodes an unknown value (JSON, config) into a policy; shape and consistency issues alike fail with `InvalidPolicy`. */
const decode = (
  input: unknown,
  conditions: ConditionMap = {},
): Effect.Effect<Policy, InvalidPolicy> =>
  Schema.decodeUnknown(PolicyDefinitionSchema, { errors: "all" })(input).pipe(
    Effect.mapError((error) => new InvalidPolicy({ issues: formatIssues(error) })),
    Effect.flatMap((definition) => make(definition, conditions)),
  );

/**
 * Declares the policy statically and fully typed: grants are checked against
 * the declared `resource:action` vocabulary (plus `resource:*` and `*`),
 * `inherits` against the declared roles, `when` against the declared
 * conditions. The remaining consistency rules (inheritance cycles, unknown
 * condition names when `conditions` is omitted) are validated eagerly and
 * throw `InvalidPolicy` at definition time — a policy is startup wiring.
 *
 * ```ts
 * const policy = Policy.define({
 *   resources: { invoice: ["read", "create", "approve"] },
 *   conditions: { owner: Condition.owner() },
 *   roles: {
 *     viewer: { grants: ["invoice:read"] },
 *     clerk: { inherits: ["viewer"], grants: ["invoice:create", { permission: "invoice:approve", when: "owner" }] },
 *     admin: { grants: ["*"] },
 *   },
 * });
 * type Permission = PolicyPermission<typeof policy>; // "invoice:read" | "invoice:create" | "invoice:approve"
 * ```
 */
const define = <
  const Resources extends ResourceDefinitions,
  const Conditions extends ConditionMap,
  const Roles extends Readonly<
    Record<
      string,
      RoleDefinition<
        ResourceGrant<Resources>,
        Extract<keyof Roles, string>,
        Extract<keyof Conditions, string>
      >
    >
  >,
>(input: {
  readonly resources: Resources;
  readonly conditions?: Conditions;
  readonly roles: Roles;
}): Policy<ResourcePermission<Resources>, Extract<keyof Roles, string>> => {
  const result = make({ resources: input.resources, roles: input.roles }, input.conditions ?? {});
  if (Either.isLeft(result)) throw result.left;
  // `build` is the untyped core; the typed facade narrows to this definition's vocabulary.
  return result.right as unknown as Policy<
    ResourcePermission<Resources>,
    Extract<keyof Roles, string>
  >;
};

/** Policy constructors: typed static definition, validated runtime form, decoding from data. */
export const Policy = {
  define,
  make,
  decode,
} as const;
