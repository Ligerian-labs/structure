---
name: expose-mcp-tool
description: Expose app capabilities to coding agents as MCP tools or resources in a @structure-based app. Use when an agent (Claude Code etc.) should be able to call into the app.
---

# Expose an MCP tool

The MCP server makes an app's capabilities callable by coding agents. Errors cross the boundary as messages only — never stacks or internals. Reference: `packages/mcp/README.md`.

## Steps

1. **Existing command/query? Bridge it** — one line, parameters and validation come from the definition:

```ts
import { toolFromCommand, toolFromQuery } from "@structure-ai/mcp";

const approve = toolFromCommand(ApproveInvoice); // tool name "approve-invoice"
```

2. **Custom capability? Define a tool** with Schema parameters and success:

```ts
import { defineTool } from "@structure-ai/mcp";

const search = defineTool({
  name: "search-invoices",
  description: "Search invoices by status.", // written for the calling agent: say what it does and returns
  parameters: { status: Schema.Literal("pending", "approved") },
  success: Schema.Array(Schema.Struct({ id: Schema.String })),
  handler: ({ status }) => /* Effect — typically a ViewStore read or bus dispatch */,
});
```

3. **Read-only data agents should browse → resource**, not tool: `defineResource({ uri, name, read })`.
4. **Serve it:** `runStdio({ name, version, tools, resources })` for local agents (stdout stays a clean MCP channel; logs go to stderr) or `runHttp({ ..., port })`.
5. **Authorization:** tools dispatching commands inherit the bus's `Authorizer` — set an actor/authorizer appropriate for agent callers; don't expose destructive commands without one.
6. **Remote agents (claude.ai, Claude Code over HTTP) → OAuth 2.1 resource server.** Add `auth` to the HTTP options: `verify` turns the bearer into a principal (the built-in provider's `verifyAccessToken` from `@structure-ai/auth`, or any introspection call), `within: Principal.within` propagates it to `@structure-ai/authorization` guards, `resourceMetadata` is what RFC 9728 publishes. Declare `scopes` on tools that need them and set `defaultScopes` for the rest — an undeclared tool without `defaultScopes` is guarded by the bearer check only.

```ts
import { makeAuthorizationServer, type AccessTokenClaims } from "@structure-ai/auth";
import { Principal } from "@structure-ai/authorization";
import { httpServerLayer, type McpPrincipal } from "@structure-ai/mcp";

const oauth = makeAuthorizationServer({ store, resolveTenant, signingKeys });
const toPrincipal = (claims: AccessTokenClaims): McpPrincipal => ({
  id: claims.sub,
  kind: "user",
  tenantId: claims.tenantId,
  roles: [{ role: "agent", scope: `tenant:${claims.tenantId}` }],
  scopes: claims.scope.split(" ").filter((scope) => scope.length > 0),
});

httpServerLayer({
  name: "billing", version: "1.0.0", path: "/mcp", port: 3001,
  tools: [search, approve], // approve = defineTool({ ..., scopes: ["invoices:write"] })
  auth: {
    verify: (token) => oauth.verifyAccessToken("acme", token).pipe(Effect.map(toPrincipal)),
    within: Principal.within,
    defaultScopes: ["invoices:read"], // required by every tool that declares no scopes
    resourceMetadata: {
      resource: "https://api.example.com/mcp",
      authorizationServers: ["https://api.example.com"], // the issuer serving /.well-known/oauth-authorization-server
      scopesSupported: ["invoices:read", "invoices:write"],
    },
  },
});
```

   Unauthenticated calls get `401` + `WWW-Authenticate: Bearer resource_metadata="https://api.example.com/.well-known/oauth-protected-resource/mcp"`; a token lacking a tool's scope gets `403 insufficient_scope`. The verdict (`required ⊆ granted`, asserted at dispatch) is logged once per call as `mcp: scope verdict` with the required/granted/missing sets. Resources are not scoped — guard sensitive ones inside `read` with the policy. Verifier failures never reach the client. Tests: `packages/mcp/test/auth.test.ts`.
7. **Tests:** drive the real protocol in-process over the HTTP transport (`tools/list`, `tools/call`) — follow `packages/mcp/test/mcp.test.ts`. Assert invalid params produce a tool error, and a failing handler surfaces only its message. With `auth`: no token → 401 + challenge, bad token → 401, missing scope → 403.

## Rules

- Tool descriptions are the agent's only documentation — state purpose, parameters, and result shape explicitly.
- Prefer bridging cqrs definitions over hand-rolled handlers: validation, tracing, idempotency, and authorization come from the bus.
- Never expose raw SQL, event-store writes, or another context's internals as tools.
- Scoped tools fail closed on every transport: over stdio, wrap `Layer.launch(stdioLayer(...))` in `McpPrincipal.within(principal)` or leave `scopes` off. Opt a tool out of `defaultScopes` only with an explicit `scopes: []`.

## Verify

`bun x tsc --noEmit && bun test` in the package.
