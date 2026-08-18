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
| `httpLayer` / `runHttp(options)` | The library's JSON-RPC-over-HTTP transport on Bun. |

Tests drive the real MCP JSON-RPC protocol in-process (`tools/list`, `tools/call`, `resources/read`) — see `test/mcp.test.ts` for working end-to-end examples.
