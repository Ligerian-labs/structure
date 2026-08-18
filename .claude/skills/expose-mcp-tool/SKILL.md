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
6. **Tests:** drive the real protocol in-process over the HTTP transport (`tools/list`, `tools/call`) — follow `packages/mcp/test/mcp.test.ts`. Assert invalid params produce a tool error, and a failing handler surfaces only its message.

## Rules

- Tool descriptions are the agent's only documentation — state purpose, parameters, and result shape explicitly.
- Prefer bridging cqrs definitions over hand-rolled handlers: validation, tracing, idempotency, and authorization come from the bus.
- Never expose raw SQL, event-store writes, or another context's internals as tools.

## Verify

`bun x tsc --noEmit && bun test` in the package.
