# @structure-ai/mcp

MCP server bindings on `@effect/ai`'s `McpServer`: expose an app's capabilities — schema-typed tools, resources, and existing CQRS commands/queries — to coding agents over stdio or HTTP. Errors reach the agent as messages only; stacks and internals never cross the protocol boundary.

## Usage

```ts
import { defineTool, runStdio, toolFromCommand } from "@structure-ai/mcp";
import { Effect, Schema } from "effect";

const search = defineTool({
  name: "search-invoices",
  description: "Search invoices by status.",
  parameters: { status: Schema.Literal("pending", "approved") },
  success: Schema.Array(Schema.Struct({ id: Schema.String })),
  handler: ({ status }) => findInvoices(status),
});

// one line to expose an existing command to agents:
const approve = toolFromCommand(ApproveInvoice); // tool name: "approve-invoice"

runStdio({ name: "billing", version: "1.0.0", tools: [search, approve] });
// or HTTP: runHttp({ ..., port: 3001 })
```

## Exports

| Export | What it is |
| --- | --- |
| `defineTool({ name, description?, parameters, success, handler })` | Registers a tool layer; arguments validated against the schema (invalid → tool error, never a crash); success returned as structured content + JSON text; failures **and defects** become message-only tool errors. |
| `toolFromCommand(definition, opts?)` / `toolFromQuery(...)` | Bridge a `@structure-ai/cqrs` definition to a tool: parameters = payload schema, handler dispatches on the bus from context; tag kebab-cased for the name. |
| `defineResource({ uri, name, read, ... })` | MCP resource backed by an Effect. |
| `serverLayer(options)` | Transport-agnostic server composition. |
| `stdioLayer` / `runStdio(options)` | Stdio transport for local agents; logs go to stderr so stdout stays a clean MCP channel. |
| `httpLayer` / `runHttp(options)` | The library's JSON-RPC-over-HTTP transport on Bun; `auth` turns the endpoint into an OAuth 2.1 protected resource (below). |
| `defineTool({ scopes })` / `toolFromCommand(def, { scopes })` | OAuth scopes the caller must hold, asserted at dispatch (`403 insufficient_scope` over HTTP, tool error elsewhere; required scopes and no principal → refused). Undeclared inherits `auth.defaultScopes`; `[]` opts out. |
| `McpAuthOptions` | `{ verify, resourceMetadata, defaultScopes?, within? }` — bearer verification hook, RFC 9728 document, scopes required by tools that declare none, optional principal propagation hook. |
| `ScopeVerdict` / `scopeVerdict(tool, required, principal)` | The per-call grant decision (`requiredScopes`, `grantedScopes`, `missingScopes`, `outcome`, `principal`); logged once per guarded call. |
| `McpPrincipal` (type + `McpPrincipal.current` / `.within`) | Structural principal (`id`, `roles`, `kind?`, `tenantId?`, `attributes?`, `scopes?`) compatible with `@structure-ai/authorization`'s `Principal`; read it from a handler, or attach one around a stdio server. |
| `ProtectedResourceMetadata` (schema) / `protectedResourceMetadata(opts)` / `resourceMetadataUrl(opts)` | The published RFC 9728 document, its builder, and the URL advertised in the challenge. |
| `InsufficientScope` | Tagged error (`permanent`) wrapping a denied `ScopeVerdict` (`tool`, `missing`). |

Tests drive the real MCP JSON-RPC protocol in-process (`tools/list`, `tools/call`, `resources/read`) — see `test/mcp.test.ts` for working end-to-end examples.

## OAuth 2.1 resource server (HTTP)

Remote agents (claude.ai connectors, Claude Code over HTTP) expect the resource-server half of the MCP authorization spec: an unauthenticated request gets `401` plus a `WWW-Authenticate` challenge pointing at the protected-resource metadata, that document names the authorization server(s), and every request carries a bearer token the server verifies. `httpLayer` / `httpServerLayer` / `runHttp` do all of it when `auth` is set:

```ts
import { type AccessTokenClaims, makeAuthorizationServer } from "@structure-ai/auth";
import { Principal } from "@structure-ai/authorization";
import { defineTool, httpServerLayer, type McpPrincipal } from "@structure-ai/mcp";
import { Effect, Schema } from "effect";

// The built-in OAuth 2.1 provider (see @structure-ai/auth); any verifier works.
const oauth = makeAuthorizationServer({ store, resolveTenant, signingKeys });

const toPrincipal = (claims: AccessTokenClaims): McpPrincipal => ({
  id: claims.sub,
  kind: "user",
  tenantId: claims.tenantId,
  roles: [{ role: "agent", scope: `tenant:${claims.tenantId}` }],
  scopes: claims.scope.split(" ").filter((scope) => scope.length > 0),
});

const approve = defineTool({
  name: "approve-invoice",
  description: "Approves a pending invoice.",
  parameters: { id: Schema.String },
  success: Schema.Struct({ approved: Schema.String }),
  scopes: ["invoices:write"], // the token must carry it
  handler: ({ id }) => approveInvoice(id),
});

const mcp = httpServerLayer({
  name: "billing",
  version: "1.0.0",
  path: "/mcp",
  port: 3001,
  tools: [search, approve],
  auth: {
    // Any failure → 401 invalid_token; the failure is never echoed to the client.
    // `request` is the HttpServerRequest (resolve the tenant from its host if you need to).
    verify: (token) => oauth.verifyAccessToken("acme", token).pipe(Effect.map(toPrincipal)),
    // Lets @structure-ai/authorization guards (policy.require, the bus Authorizer) see the caller.
    within: Principal.within,
    resourceMetadata: {
      resource: "https://api.example.com/mcp",
      authorizationServers: ["https://api.example.com"], // issuer serving /.well-known/oauth-authorization-server
      scopesSupported: ["invoices:read", "invoices:write"],
    },
  },
});
```

What the wire looks like:

| Request | Response |
| --- | --- |
| No `Authorization: Bearer` | `401`, `WWW-Authenticate: Bearer resource_metadata="https://api.example.com/.well-known/oauth-protected-resource/mcp"` |
| Token the verifier rejects | `401`, `WWW-Authenticate: Bearer error="invalid_token", error_description="…", resource_metadata="…"` |
| `tools/call` on a tool whose `scopes` the token lacks | `403`, `WWW-Authenticate: Bearer error="insufficient_scope", scope="invoices:write", resource_metadata="…"` |
| `GET /.well-known/oauth-protected-resource` and `GET /.well-known/oauth-protected-resource/mcp` | The RFC 9728 document (`resource`, `authorization_servers`, `scopes_supported`, `bearer_methods_supported: ["header"]`), unauthenticated |
| Verified token | The request runs inside `McpPrincipal.within(principal)` and your `within` hook, so tools, resources and every guard below see the caller |

### Scope enforcement

Every `tools/call` is asserted at dispatch, not inferred from declarations: `required = tool.scopes ?? auth.defaultScopes ?? []`, `granted = principal.scopes ?? []`, and the call runs only when `required ⊆ granted`. The pre-RPC guard (which answers `403`) and the tool handler (which answers a tool error on other transports) compute the verdict from the same two sets, so they cannot disagree.

- **`defaultScopes`** is the one knob: set it whenever tokens may carry fewer scopes than the server exposes, and every tool that declares nothing requires those scopes. A tool opts out only by declaring `scopes: []` explicitly — there is no boolean that can switch enforcement off by accident.
- **Neither `scopes` nor `defaultScopes`** means scope enforcement is off for that tool: it is still behind the bearer check, but any verified token may call it. The verdict log makes this visible (`requiredScopes=[]`).
- **Resources are not scoped.** `resources/read` runs inside the principal (so `@structure-ai/authorization` guards inside `read` apply) but carries no scope requirement; keep resources read-only and guard sensitive ones with a policy check.
- **One log line per guarded call**, `mcp: scope verdict`, at `debug` when allowed and `warning` when denied, annotated with `tool`, `principal`, `requiredScopes`, `grantedScopes`, `missingScopes`, `outcome` (`allowed` | `insufficient_scope` | `unauthenticated`). It inherits annotations already on the fiber — `Correlation.within` (applied by `Principal.within` through the `within` hook) adds `correlationId` and `actor`. The token never appears. `scopeVerdict` is exported so a reader can recompute the same `401`/`403` from the logged sets.

Rules baked in: the challenge and the well-known paths derive from `resourceMetadata.resource` (an absolute URL, validated at composition time), never from the `Host` header; responses carry RFC 6750 error codes only, never the verifier's failure; scoped tools fail closed on every transport (over stdio wrap `Layer.launch(stdioLayer(...))` in `McpPrincipal.within(principal)` or leave `scopes` off). This package depends on neither `@structure-ai/auth` nor `@structure-ai/authorization` — `verify` and `within` are where the application composes them.
