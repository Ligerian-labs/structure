# @structure-ai/authorization

Roles × permissions as a typed, validated matrix; a `Principal` propagated on the fiber; and guards that restrict plain effects, CQRS dispatches and HTTP requests. Authentication is out of scope: once a caller is identified (session, token, API key — e.g. via `@structure-ai/auth`), build a `Principal` and attach it with `Principal.within`; everything below checks against the policy.

Design rules: **fail closed** (unknown roles grant nothing, unmapped messages are denied, conditional grants without attributes are denied), **explain every decision** (`Decision.reason`), **authorize the action, not the endpoint** (permissions name `resource:action`; HTTP and CQRS guards are thin adapters over the same policy).

## Quick start

```ts
import { Condition, Policy, type PolicyPermission, Principal } from "@structure-ai/authorization";
import { Effect } from "effect";

export const policy = Policy.define({
  resources: {
    invoice: ["read", "create", "approve", "delete"],
    user: ["read", "invite"],
  },
  conditions: {
    owner: Condition.owner(), // attributes.ownerId === principal.id
  },
  roles: {
    viewer: { grants: ["invoice:read", "user:read"] },
    clerk: { inherits: ["viewer"], grants: ["invoice:create", { permission: "invoice:delete", when: "owner" }] },
    manager: { inherits: ["clerk"], grants: ["invoice:approve", "user:invite"] },
    admin: { grants: ["*"] }, // "invoice:*" grants one resource
  },
});

export type Permission = PolicyPermission<typeof policy>; // "invoice:read" | "invoice:create" | ...

// Pure decisions for an explicit principal
policy.can({ id: "ada", roles: ["clerk"] }, "invoice:approve"); // false
policy.allowedPermissions({ id: "ada", roles: ["clerk"] });
// → ["invoice:read", "invoice:create", "user:read"] (definition order)
policy.decide({ id: "ada", roles: ["clerk"] }, "invoice:delete", { attributes: { ownerId: "ada" } });
// → { allowed: true, role: "clerk", condition: "owner", reason: 'granted by role "clerk" under condition "owner"' }

// Effect checks against the fiber's principal
const approve = Effect.gen(function* () {
  yield* policy.check("invoice:approve");
  // ...
}).pipe(policy.require("invoice:read")); // or wrap: the effect runs only when the check passes

Principal.within({ id: "ada", roles: ["manager"] })(approve); // ok
Principal.within({ id: "bob", roles: ["viewer"] })(approve); // fails with PermissionDenied
approve; // no principal attached → fails with Unauthenticated
```

`Policy.define` validates eagerly (grants must name declared permissions, `inherits` declared roles, `when` declared conditions — mostly at compile time; cycles and the rest at definition time) and throws `InvalidPolicy` listing every issue. `policy.toMarkdown()` renders the resolved matrix:

| Permission | viewer | clerk | manager | admin |
| --- | --- | --- | --- | --- |
| `invoice:read` | ✓ | ✓ | ✓ | ✓ |
| `invoice:create` | · | ✓ | ✓ | ✓ |
| `invoice:approve` | · | · | ✓ | ✓ |
| `invoice:delete` | · | ✓ (owner) | ✓ (owner) | ✓ |
| `user:read` | ✓ | ✓ | ✓ | ✓ |
| `user:invite` | · | · | ✓ | ✓ |

## Principals, scopes, conditions

```ts
const principal: Principal = {
  id: "bob",
  roles: ["viewer", { role: "manager", scope: "tenant:acme" }], // plain = everywhere, scoped = only there
  tenantId: "acme",
  attributes: { department: "finance" },
};
policy.can(principal, "invoice:approve"); // false — no scope named
policy.can(principal, "invoice:approve", { scope: "tenant:acme" }); // true
```

- **Scopes** are opaque strings the application chooses (`tenant:…`, `org:…`, `project:…`). A check without `scope` sees only the principal's unscoped roles.
- **Conditions** refine a grant with facts about the resource instance (`CheckOptions.attributes`) and the principal. Built-ins: `Condition.owner(key?)`, `sameTenant(key?)`, `attributeEquals`, `attributeIn`, `principalAttributeEquals`, and `all`/`any`/`not`. Write your own as `(context) => boolean`; they must be pure.
- **Unconditional beats conditional** when several roles grant the same permission.
- `Principal.anonymous` lets unauthenticated callers be evaluated (e.g. against a `guest` role); when it is denied the failure is `Unauthenticated` (401), not `PermissionDenied` (403).
- `Principal.within(p)` also tags the correlation context with `actor: p.id`, so logs, spans and CQRS dispatches carry who acted.

## Restricting a CQRS bus

The bus already has an `Authorizer` hook; build it from the policy and per-message rules (typed payloads flow into rule functions):

```ts
import { CqrsAuthorization } from "@structure-ai/authorization";
import { CommandBus, QueryBus, HandlerRegistry, IdempotencyStore } from "@structure-ai/cqrs";

const AuthorizerLive = CqrsAuthorization.rules(policy)
  .message(ApproveInvoice, "invoice:approve")
  .message(DeleteInvoice, (payload) => ({ permission: "invoice:delete", attributes: { ownerId: payload.ownerId } }))
  .message(ListInvoices, (payload) => ({ permission: "invoice:read", scope: `tenant:${payload.tenantId}` }))
  .public(Ping)
  .layer;

const BusLive = Layer.mergeAll(CommandBus.layer, QueryBus.layer).pipe(
  Layer.provide(Layer.mergeAll(handlers, AuthorizerLive, IdempotencyStore.inMemory)),
);
```

Messages without a rule are denied (`unmapped: "allow"` opts out, explicitly). The principal comes from the fiber; when only a dispatch `actor` id is known (jobs, CLI), pass `resolvePrincipal` to look it up. Denials surface as the bus's `Unauthorized` error carrying the decision reason; `rules.tags` lets a test assert every registered handler is covered.

## Restricting HTTP

```ts
import { HttpAuthorization } from "@structure-ai/authorization";

// 1. Resolve the principal once per request (you own the lookup).
const PrincipalLive = HttpAuthorization.layer(
  HttpAuthorization.fromBearer((token) => sessions.lookup(token)), // Effect<Option<Principal>>
);
// provide it next to your api implementation (`serve`/`serveTest` in @structure-ai/http take extra layers)

// 2. Guard handlers (or whole HttpApps).
handlers.handle("approve", ({ payload }) =>
  approveInvoice(payload).pipe(HttpAuthorization.requirePermission(policy, "invoice:approve")),
);
```

Guards fail with `Unauthenticated` / `PermissionDenied`; `@structure-ai/http`'s problem mapping renders them as 401 / 403 without leaking the decision reason. Resolvers for the layer must not fail: treat unverifiable credentials as anonymous (`Option.none()`) so guards answer 401, and let infrastructure failures die. `HttpAuthorization.principal(resolve)` is the same middleware at `HttpApp` level for manual composition (there it may fail with the resolver's errors).

## As a service

Code that should not import the policy module (shared handlers, libraries, tests swapping the policy) uses the `Authorization` service with string permissions; a permission the policy does not declare dies (wiring bug):

```ts
import { Authorization } from "@structure-ai/authorization";

const program = Effect.gen(function* () {
  yield* Authorization.check("invoice:approve");
  const decision = yield* Authorization.decide("invoice:delete", { attributes: invoice });
}).pipe(Authorization.require("invoice:read"));

program.pipe(Effect.provide(Authorization.layer(policy)));
```

## Policies from data

`PolicyDefinitionSchema` + `Policy.decode(json, conditions)` load a definition at startup (roles in config/DB); conditions bind by name. `Policy.make(definition, conditions)` is the `Either`-returning form. Either way the same validation applies and `InvalidPolicy` lists all issues at once.

## Exports

| Export | Purpose |
| --- | --- |
| `Policy.define` / `make` / `decode`, `PolicyDefinitionSchema` | Typed static definition; validated runtime form; decoding from data. |
| `Policy` (value): `permissions`, `roles`, `isPermission`, `isRole`, `grantsOf`, `decide`, `can`, `allowedPermissions`, `check`, `require`, `requireRole`, `matrix`, `toMarkdown` | Vocabulary, pure decisions and effective-permission projection, fiber-scoped guards, matrix rendering. |
| `PolicyPermission<P>`, `PolicyRole<P>`, `ResourcePermission<R>`, `Decision`, `CheckOptions`, `PolicyMatrix` | Types. |
| `Principal` (type + `anonymous`, `isAnonymous`, `hasRole`, `rolesIn`, `current`, `required`, `within`, `without`), `RoleAssignment` | Who acts, and fiber propagation. |
| `Condition` (`owner`, `sameTenant`, `attributeEquals`, `attributeIn`, `principalAttributeEquals`, `all`, `any`, `not`), `ConditionContext` | Conditional grants. |
| `Authorization` (service tag, `layer`, `make`, static `check`/`can`/`decide`/`require`/`requireRole`/`principal`) | Service form. |
| `CqrsAuthorization.rules(policy, options)` → `.message`/`.messages`/`.public`/`.tags`/`.authorize`/`.layer` | Bus `Authorizer` from policy + message rules. |
| `HttpAuthorization` (`layer`, `principal`, `fromBearer`, `bearerToken`, `requirePermission`, `requireRole`, `requireAuthenticated`) | Request principal resolution and route guards. |
| `Unauthenticated` (401), `PermissionDenied` (403), `InvalidPolicy` | Tagged errors with `classification: "permanent"`. |

See `test/` for executable examples of each surface (policy resolution, service, CQRS bus, HTTP end to end).
