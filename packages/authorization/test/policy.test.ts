import { describe, expect, test } from "bun:test";
import { Correlation } from "@structure-ai/observability";
import { Effect, Either, Exit, Option } from "effect";
import {
  Condition,
  InvalidPolicy,
  PermissionDenied,
  Policy,
  type PolicyPermission,
  type PolicyRole,
  Principal,
  Unauthenticated,
} from "../src/index.js";

// --- a policy shared by most tests ------------------------------------------

const policy = Policy.define({
  resources: {
    invoice: ["read", "create", "approve", "delete"],
    user: ["read", "invite"],
  },
  conditions: {
    owner: Condition.owner(),
    draft: Condition.attributeEquals("status", "draft"),
    sameTenant: Condition.sameTenant(),
  },
  roles: {
    viewer: { description: "Read-only", grants: ["invoice:read", "user:read"] },
    clerk: {
      inherits: ["viewer"],
      grants: ["invoice:create", { permission: "invoice:delete", when: "owner" }],
    },
    manager: { inherits: ["clerk"], grants: ["invoice:approve", "user:invite"] },
    auditor: { grants: ["invoice:*"] },
    admin: { grants: ["*"] },
    tenantEditor: { grants: [{ permission: "invoice:delete", when: "sameTenant" }] },
  },
});

type Permission = PolicyPermission<typeof policy>;
type Role = PolicyRole<typeof policy>;

const user = (id: string, ...roles: Principal["roles"]): Principal => ({ id, roles });

describe("Policy.define", () => {
  test("derives the permission vocabulary and resolves inheritance + wildcards", () => {
    expect(policy.permissions).toEqual([
      "invoice:read",
      "invoice:create",
      "invoice:approve",
      "invoice:delete",
      "user:read",
      "user:invite",
    ]);
    expect(policy.roles).toEqual([
      "viewer",
      "clerk",
      "manager",
      "auditor",
      "admin",
      "tenantEditor",
    ]);

    // Type-level: these unions are exact; a typo would not compile.
    const permission: Permission = "invoice:approve";
    const role: Role = "clerk";
    expect(policy.isPermission(permission)).toBe(true);
    expect(policy.isRole(role)).toBe(true);
    expect(policy.isPermission("invoice:nope")).toBe(false);

    expect(policy.grantsOf("manager")).toEqual([
      { permission: "invoice:read", conditions: [] },
      { permission: "invoice:create", conditions: [] },
      { permission: "invoice:approve", conditions: [] },
      { permission: "invoice:delete", conditions: ["owner"] },
      { permission: "user:read", conditions: [] },
      { permission: "user:invite", conditions: [] },
    ]);
    expect(policy.grantsOf("auditor").map((g) => g.permission)).toEqual([
      "invoice:read",
      "invoice:create",
      "invoice:approve",
      "invoice:delete",
    ]);
    expect(policy.grantsOf("admin").length).toBe(policy.permissions.length);
  });

  test("decide: unconditional grants, explained", () => {
    const decision = policy.decide(user("ada", "clerk"), "invoice:create");
    expect(decision).toEqual({
      allowed: true,
      permission: "invoice:create",
      principal: "ada",
      role: "clerk",
      reason: 'granted by role "clerk"',
    });
    expect(policy.can(user("ada", "clerk"), "invoice:approve")).toBe(false);
    expect(policy.decide(user("ada", "clerk"), "invoice:approve").reason).toBe(
      'no role of [clerk] grants "invoice:approve"',
    );
  });

  test("decide: conditional grants consult the resource attributes and fail closed without them", () => {
    const ada = user("ada", "clerk");
    expect(policy.can(ada, "invoice:delete", { attributes: { ownerId: "ada" } })).toBe(true);
    expect(policy.decide(ada, "invoice:delete", { attributes: { ownerId: "ada" } })).toMatchObject({
      role: "clerk",
      condition: "owner",
    });
    expect(policy.can(ada, "invoice:delete", { attributes: { ownerId: "bob" } })).toBe(false);
    expect(policy.can(ada, "invoice:delete")).toBe(false);
    expect(policy.decide(ada, "invoice:delete").reason).toBe(
      "conditional grant(s) not met: clerk (owner)",
    );
    // sameTenant needs both sides.
    const tenantUser: Principal = { id: "eve", roles: ["tenantEditor"], tenantId: "acme" };
    expect(policy.can(tenantUser, "invoice:delete", { attributes: { tenantId: "acme" } })).toBe(
      true,
    );
    expect(policy.can(tenantUser, "invoice:delete", { attributes: { tenantId: "other" } })).toBe(
      false,
    );
    expect(
      policy.can({ id: "x", roles: ["tenantEditor"] }, "invoice:delete", {
        attributes: { tenantId: undefined },
      }),
    ).toBe(false);
  });

  test("decide: an unconditional grant wins over a conditional one on the same permission", () => {
    // admin has everything unconditionally; clerk only conditionally.
    const both = user("root", "clerk", "admin");
    expect(policy.decide(both, "invoice:delete")).toMatchObject({ allowed: true, role: "admin" });
  });

  test("decide: scoped role assignments only apply when the check names their scope", () => {
    const member: Principal = {
      id: "bob",
      roles: ["viewer", { role: "manager", scope: "tenant:acme" }],
    };
    expect(policy.can(member, "invoice:approve")).toBe(false);
    expect(policy.can(member, "invoice:approve", { scope: "tenant:other" })).toBe(false);
    expect(policy.can(member, "invoice:approve", { scope: "tenant:acme" })).toBe(true);
    expect(policy.decide(member, "invoice:approve", { scope: "tenant:acme" })).toMatchObject({
      scope: "tenant:acme",
      role: "manager",
    });
    // Global roles keep applying inside any scope.
    expect(policy.can(member, "invoice:read", { scope: "tenant:other" })).toBe(true);
  });

  test("decide: unknown roles and roleless principals deny with a reason", () => {
    expect(policy.decide(user("ghost"), "invoice:read").reason).toBe("principal holds no role");
    expect(policy.decide(user("ghost", "superuser"), "invoice:read").reason).toBe(
      "none of the roles [superuser] is defined in the policy",
    );
    expect(
      policy.decide(user("ghost", { role: "admin", scope: "tenant:a" }), "invoice:read", {
        scope: "tenant:b",
      }).reason,
    ).toBe('principal holds no role in scope "tenant:b"');
    // An undeclared permission (only reachable through the string API) denies too.
    const loose: Policy = policy;
    expect(loose.decide(user("root", "admin"), "invoice:explode").reason).toBe(
      'unknown permission "invoice:explode"',
    );
  });

  test("matrix and markdown render the resolved table", () => {
    const matrix = policy.matrix();
    expect(matrix.cells.clerk["invoice:read"]).toEqual({ kind: "granted" });
    expect(matrix.cells.clerk["invoice:delete"]).toEqual({
      kind: "conditional",
      conditions: ["owner"],
    });
    expect(matrix.cells.viewer["invoice:approve"]).toEqual({ kind: "denied" });

    const markdown = policy.toMarkdown();
    expect(markdown.split("\n")[0]).toBe(
      "| Permission | viewer | clerk | manager | auditor | admin | tenantEditor |",
    );
    expect(markdown).toContain(
      "| `invoice:delete` | · | ✓ (owner) | ✓ (owner) | ✓ | ✓ | ✓ (sameTenant) |",
    );
  });
});

describe("Policy validation", () => {
  test("Policy.make reports every inconsistency at once", () => {
    const result = Policy.make(
      {
        resources: { invoice: ["read", "read"], "bad:name": ["x"], empty: [] },
        roles: {
          a: {
            inherits: ["b"],
            grants: ["invoice:write", "ghost:*", { permission: "invoice:read", when: "nope" }],
          },
          b: { inherits: ["c"] },
          c: { inherits: ["a"] },
        },
      },
      {},
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(InvalidPolicy);
      expect(result.left.classification).toBe("permanent");
      expect(result.left.issues).toEqual([
        'resource "invoice": duplicate action "read"',
        'resource "bad:name": name must be non-empty, without ":" or "*"',
        'resource "empty": declares no action',
        'role "a": grant "invoice:write" is not a declared permission',
        'role "a": grant "ghost:*" names unknown resource "ghost"',
        'role "a": grant "invoice:read" references unknown condition "nope"',
        "inheritance cycle: a -> b -> c -> a",
      ]);
    }
  });

  test("Policy.define throws InvalidPolicy eagerly (wiring bug, not a runtime failure)", () => {
    expect(() =>
      Policy.define({
        resources: { doc: ["read"] },
        roles: { a: { inherits: ["b"] }, b: { inherits: ["a"] } },
      }),
    ).toThrow(InvalidPolicy);
  });

  test("Policy.decode loads a definition from data, binding conditions by name", async () => {
    const json = JSON.parse(
      JSON.stringify({
        resources: { doc: ["read", "edit"] },
        roles: {
          reader: { grants: ["doc:read"] },
          author: { inherits: ["reader"], grants: [{ permission: "doc:edit", when: "owner" }] },
        },
      }),
    );
    const loaded = await Effect.runPromise(Policy.decode(json, { owner: Condition.owner() }));
    expect(loaded.can(user("ada", "author"), "doc:edit", { attributes: { ownerId: "ada" } })).toBe(
      true,
    );
    expect(loaded.can(user("ada", "author"), "doc:edit")).toBe(false);

    const bad = await Effect.runPromise(Effect.flip(Policy.decode({ resources: 1 })));
    expect(bad).toBeInstanceOf(InvalidPolicy);
    expect(bad.issues.length).toBeGreaterThan(0);
  });
});

describe("Principal and fiber-scoped checks", () => {
  test("check passes for the attached principal and fails typed otherwise", async () => {
    const program = policy.check("invoice:approve");
    const ok = await Effect.runPromise(Principal.within(user("ada", "manager"))(program));
    expect(ok).toBeUndefined();

    const denied = await Effect.runPromise(
      Principal.within(user("bob", "viewer"))(Effect.flip(program)),
    );
    expect(denied).toBeInstanceOf(PermissionDenied);
    expect((denied as PermissionDenied).principal).toBe("bob");
    expect(denied.message).toBe(
      'principal "bob" lacks "invoice:approve": no role of [viewer] grants "invoice:approve"',
    );

    const noPrincipal = await Effect.runPromise(Effect.flip(program));
    expect(noPrincipal).toBeInstanceOf(Unauthenticated);

    const anonymous = await Effect.runPromise(
      Principal.within(Principal.anonymous)(Effect.flip(program)),
    );
    expect(anonymous).toBeInstanceOf(Unauthenticated);
    expect(anonymous.message).toContain("principal holds no role");
  });

  test("require only runs the effect once the check passed; requireRole checks role membership", async () => {
    let ran = 0;
    const work = Effect.sync(() => {
      ran += 1;
      return "done";
    });
    const guarded = work.pipe(policy.require("invoice:approve"));
    const viewerExit = await Effect.runPromiseExit(Principal.within(user("v", "viewer"))(guarded));
    expect(Exit.isFailure(viewerExit)).toBe(true);
    expect(ran).toBe(0);
    const managerResult = await Effect.runPromise(Principal.within(user("m", "manager"))(guarded));
    expect(managerResult).toBe("done");
    expect(ran).toBe(1);

    const adminOnly = work.pipe(policy.requireRole("admin"));
    const error = await Effect.runPromise(
      Principal.within(user("m", "manager"))(Effect.flip(adminOnly)),
    );
    expect(error).toBeInstanceOf(PermissionDenied);
    expect((error as PermissionDenied).permission).toBe("role:admin");
    await Effect.runPromise(Principal.within(user("r", "admin"))(adminOnly));
    await Effect.runPromise(
      Principal.within(user("s", { role: "admin", scope: "org:1" }))(
        work.pipe(policy.requireRole("admin", { scope: "org:1" })),
      ),
    );
  });

  test("Principal.within exposes the principal, tags the correlation actor, and Principal.without clears it", async () => {
    const result = await Effect.runPromise(
      Principal.within(user("ada", "viewer"))(
        Effect.gen(function* () {
          const current = yield* Principal.current;
          const required = yield* Principal.required;
          const correlation = yield* Correlation.current;
          const cleared = yield* Principal.without(Principal.current);
          return { current, required: required.id, actor: correlation.actor, cleared };
        }),
      ),
    );
    expect(Option.isSome(result.current)).toBe(true);
    expect(result.required).toBe("ada");
    expect(result.actor).toBe("ada");
    expect(Option.isNone(result.cleared)).toBe(true);

    const missing = await Effect.runPromise(Effect.flip(Principal.required));
    expect(missing).toBeInstanceOf(Unauthenticated);
    expect(Principal.hasRole(user("x", { role: "a", scope: "s" }), "a")).toBe(false);
    expect(Principal.hasRole(user("x", { role: "a", scope: "s" }), "a", "s")).toBe(true);
  });
});
