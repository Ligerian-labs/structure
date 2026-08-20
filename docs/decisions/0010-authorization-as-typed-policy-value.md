# ADR-0010: Authorization is a typed, fail-closed policy value; transports adapt to it

- Status: accepted
- Date: 2026-08-20

## Context

Applications need to restrict who may run which use case. The CQRS bus already exposes an `Authorizer` hook and HTTP has problem mapping, but nothing defined roles and permissions, so every app would invent its own matrix, its own principal plumbing, and its own 401/403 semantics — and agents writing handlers would have nothing to follow.

Authentication is deliberately separate (ADR-0009 keeps `@structure-ai/auth` to credentials and sessions). Authorization must therefore accept any identified caller, stay usable for jobs/CLI/MCP as well as HTTP, and never depend on a specific auth implementation.

## Decision

`@structure-ai/authorization` models authorization as a **policy value** built by `Policy.define({ resources, conditions, roles })`:

- The permission vocabulary is derived (`resource:action` template-literal union), so grants, rules and guards are checked at compile time; roles inherit transitively; `resource:*` and `*` wildcards expand at definition time; inconsistencies (unknown permission/role/condition, inheritance cycles) fail at definition with every issue listed.
- RBAC is the core; **conditional grants** (`{ permission, when }` + pure `Condition` predicates over resource/principal attributes) cover the common attribute-based cases without a policy language; **scoped role assignments** cover multi-tenant/organisation membership without a separate model.
- The acting **`Principal` travels on the fiber** (`Principal.within`, like `Correlation`), and tags the correlation `actor`. Checks distinguish `Unauthenticated` (no/anonymous principal → 401) from `PermissionDenied` (403); every decision carries a `reason`.
- **Fail closed everywhere**: unknown roles grant nothing, conditional grants without attributes deny, CQRS messages without a rule are denied unless `unmapped: "allow"` is written down, HTTP resolvers that cannot verify credentials yield anonymous.
- Transports adapt to the policy rather than the reverse: `CqrsAuthorization.rules(policy)` produces the bus `Authorizer` layer from typed per-message rules; `HttpAuthorization` resolves the principal per request and guards handlers; `Authorization` wraps the same policy as a service for code that must not import the policy module. `@structure-ai/http` learns the two new error tags structurally (401/403) and nothing else.

## Consequences

- One place defines the matrix; `policy.toMarkdown()` renders it for docs and agents, `policy.decide` explains any outcome.
- Dependency direction: `cqrs ← authorization`; `http`/`mcp` stay independent of it (apps compose). Authorization never depends on `auth`.
- Permissions are strings at the service boundary; typing lives on the policy value. A string the policy does not declare is a defect, not a silent denial.
- Not covered on purpose: policy languages (Cedar/OPA), relationship-based authorization (Zanzibar-style tuples), dynamic permission administration UIs, and per-row query filtering. A relationship model or external PDP would be a new adapter behind the same `Principal`/`Decision` vocabulary.
- Supersede if conditions outgrow predicate functions (need for serializable, auditable conditions) or if scoped assignments prove insufficient for hierarchical tenancy.
