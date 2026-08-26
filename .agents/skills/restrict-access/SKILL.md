---
name: restrict-access
description: Restrict who may run a use case, endpoint, or tool in a @structure-based app with roles and permissions. Use when adding authorization to a command/query, HTTP route, MCP tool, or job.
---

# Restrict access (roles and permissions)

Authorization is a typed policy value from `@structure-ai/authorization`: resources × actions make permissions, roles get grants (with inheritance, wildcards, conditions), a `Principal` travels on the fiber, guards check against the policy. Authenticate elsewhere (session/token → `Principal`); authorize the **action**, not the endpoint. Reference: `packages/authorization/README.md`.

## Steps

1. **Declare (or extend) the policy** — one module per app, typically `src/policy.ts`:

```ts
import { Condition, Policy, type PolicyPermission } from "@structure-ai/authorization";

export const policy = Policy.define({
  resources: { invoice: ["read", "create", "approve"] },
  conditions: { owner: Condition.owner() },
  roles: {
    viewer: { grants: ["invoice:read"] },
    clerk: { inherits: ["viewer"], grants: ["invoice:create"] },
    manager: { inherits: ["clerk"], grants: ["invoice:approve"] },
    admin: { grants: ["*"] },
  },
});
export type Permission = PolicyPermission<typeof policy>;
```

   Adding a use case usually means adding an action to a resource and granting it to the right roles. Keep the matrix readable — `policy.toMarkdown()` prints it for the README/PR.

2. **Attach the principal** where callers enter:
   - HTTP: `HttpAuthorization.layer(HttpAuthorization.fromBearer(lookup))` next to the api implementation (`lookup: token → Effect<Option<Principal>>`; unverifiable → `Option.none()`).
   - Jobs/CLI/tests: wrap the program in `Principal.within({ id, roles })`.
   - MCP tools: resolve the agent's identity in the server bootstrap and `Principal.within` the tool handlers.

3. **Guard the action**:
   - CQRS (preferred — covers every transport at once): build the bus `Authorizer` with `CqrsAuthorization.rules(policy).message(ApproveInvoice, "invoice:approve")…` and provide its `.layer` instead of `Authorizer.allowAll`. Payload-derived scope/attributes: `.message(Def, (payload) => ({ permission, scope, attributes }))`. Public messages: `.public(Def)`. Unmapped messages are denied.
   - Plain effects/handlers: `effect.pipe(policy.require("invoice:approve", { attributes }))` or `yield* policy.check(...)`.
   - HTTP-only routes (no bus): `HttpAuthorization.requirePermission(policy, "invoice:approve")` around the handler.
   - Shared code without access to the policy module: `Authorization.check("invoice:approve")` with `Authorization.layer(policy)` provided.

4. **Multi-tenant / ownership**: give principals scoped roles (`{ role: "manager", scope: "tenant:acme" }`) and pass `scope` on the check; for per-record rules use a conditional grant (`{ permission: "invoice:delete", when: "owner" }`) and pass the record's `attributes`.

5. **Tests** (`bun test`, follow `packages/authorization/test/`): one allowed and one denied principal per new permission; for the bus, assert `rules.tags` covers every registered handler; assert `Unauthenticated` without a principal.

## Rules

- Fail closed: never `unmapped: "allow"` in production wiring; never grant `"*"` to a role humans hold by default.
- Conditions are pure; load anything needing I/O in the handler before the check and pass it as `attributes`.
- Errors: `Unauthenticated` → 401, `PermissionDenied` → 403 (mapped by `@structure-ai/http`); never put the decision reason in a response, it is for logs.
- Cross-context: a context checks its own permissions; do not read another context's role tables.

## Verify

`bun x tsc --noEmit && bun test` in the package.
