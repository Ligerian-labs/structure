import { describe, expect, test } from "bun:test";
import { type McpSchema, McpServer } from "@effect/ai";
import { HttpBody, HttpClient, HttpRouter } from "@effect/platform";
import { BunHttpServer } from "@effect/platform-bun";
import {
  layer as busLayer,
  Command,
  CommandHandler,
  HandlerRegistry,
  Query,
  QueryHandler,
} from "@structure-ai/cqrs";
import { Effect, Layer, Schema } from "effect";
import {
  defineResource,
  defineTool,
  httpLayer,
  toolFromCommand,
  toolFromQuery,
} from "../src/index.js";

// --- fixtures -----------------------------------------------------------

const Add = defineTool({
  name: "add",
  description: "Adds two numbers.",
  parameters: { a: Schema.Number, b: Schema.Number },
  success: Schema.Struct({ sum: Schema.Number }),
  handler: ({ a, b }) => Effect.succeed({ sum: a + b }),
});

const Fails = defineTool({
  name: "fails",
  description: "Always fails.",
  parameters: {},
  success: Schema.Struct({}),
  handler: () => Effect.fail(new Error("the business rule was violated")),
});

const Dies = defineTool({
  name: "dies",
  description: "Always dies.",
  parameters: {},
  success: Schema.Struct({}),
  handler: () => Effect.dieMessage("unexpected defect"),
});

const Deposit = Command.define("DepositFunds", {
  payload: Schema.Struct({ amount: Schema.Number }),
  success: Schema.Struct({ balance: Schema.Number }),
});

const Withdraw = Command.define("WithdrawFunds", {
  payload: Schema.Struct({ amount: Schema.Number }),
  success: Schema.Struct({ balance: Schema.Number }),
  failure: Schema.Struct({ message: Schema.String }),
});

const GetBalance = Query.define("GetBalance", {
  payload: Schema.Struct({ account: Schema.String }),
  success: Schema.Struct({ balance: Schema.Number }),
});

const cqrsStack = busLayer.pipe(
  Layer.provide(
    HandlerRegistry.layer(
      CommandHandler.make(Deposit, ({ amount }) => Effect.succeed({ balance: amount * 2 })),
      CommandHandler.make(Withdraw, () => Effect.fail({ message: "insufficient funds" })),
      QueryHandler.make(GetBalance, () => Effect.succeed({ balance: 7 })),
    ),
  ),
);

const Readme = defineResource({
  uri: "app://readme",
  name: "README",
  description: "The application readme.",
  mimeType: "text/markdown",
  read: Effect.succeed("# hello"),
});

const Broken = defineResource({
  uri: "app://broken",
  name: "Broken",
  read: Effect.fail(new Error("storage unavailable")),
});

// --- harness ------------------------------------------------------------

/**
 * Registration layers share the memoized `McpServer.layer`, so merging that
 * layer into the stack exposes the same server instance the registrations
 * wrote to. `callTool`/`findResource` are exactly what the library's
 * `tools/call`/`resources/read` RPC handlers delegate to.
 */
const withServer = <A, E>(
  registrations: ReadonlyArray<Layer.Layer<never>>,
  effect: Effect.Effect<A, E, McpServer.McpServer | McpSchema.McpServerClient>,
): Promise<A> => {
  const stack = Layer.mergeAll(McpServer.McpServer.layer, ...registrations);
  return Effect.runPromise(effect.pipe(Effect.provide(stack)));
};

const textOf = (result: McpSchema.CallToolResult): string => {
  const block = result.content[0];
  if (block === undefined || block.type !== "text") {
    throw new Error(`expected text content, got ${JSON.stringify(result.content)}`);
  }
  return block.text;
};

const callTool = (name: string, args: Record<string, unknown>) =>
  Effect.flatMap(McpServer.McpServer, (server) => server.callTool({ name, arguments: args }));

// --- defineTool ---------------------------------------------------------

describe("defineTool", () => {
  test("registers the tool with name, description, and JSON input schema", async () => {
    const tools = await withServer(
      [Add],
      Effect.map(McpServer.McpServer, (server) => server.tools),
    );

    const add = tools.find((tool) => tool.name === "add");
    expect(add).toBeDefined();
    expect(add?.description).toBe("Adds two numbers.");
    expect(add?.inputSchema).toMatchObject({
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    });
  });

  test("calls the handler with decoded params and returns the encoded success", async () => {
    const result = await withServer([Add], callTool("add", { a: 19, b: 23 }));

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ sum: 42 });
    expect(JSON.parse(textOf(result))).toEqual({ sum: 42 });
  });

  test("invalid params produce a tool error, not a crash", async () => {
    const result = await withServer([Add], callTool("add", { a: 1, b: "nope" }));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("invalid parameters");
    expect(textOf(result)).toContain("b");
  });

  test("a failing handler surfaces the error message without a stack", async () => {
    const result = await withServer([Fails], callTool("fails", {}));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("the business rule was violated");
  });

  test("a defect surfaces its message without a stack", async () => {
    const result = await withServer([Dies], callTool("dies", {}));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("unexpected defect");
  });

  test("calling an unknown tool fails with an MCP InvalidParams error", async () => {
    const error = await withServer([Add], Effect.flip(callTool("nope", {})));

    expect(error._tag).toBe("InvalidParams");
  });
});

// --- CQRS bridge --------------------------------------------------------

describe("toolFromCommand / toolFromQuery", () => {
  const registrations = [
    toolFromCommand(Deposit).pipe(Layer.provide(cqrsStack)),
    toolFromCommand(Withdraw).pipe(Layer.provide(cqrsStack)),
    toolFromQuery(GetBalance).pipe(Layer.provide(cqrsStack)),
  ];

  test("derives a kebab-case tool name and the payload input schema", async () => {
    const tools = await withServer(
      registrations,
      Effect.map(McpServer.McpServer, (server) => server.tools),
    );

    const names = tools.map((tool) => tool.name);
    expect(names).toContain("deposit-funds");
    expect(names).toContain("get-balance");
    const deposit = tools.find((tool) => tool.name === "deposit-funds");
    expect(deposit?.inputSchema).toMatchObject({
      type: "object",
      properties: { amount: { type: "number" } },
      required: ["amount"],
    });
  });

  test("dispatches on the CommandBus and returns the success payload", async () => {
    const result = await withServer(registrations, callTool("deposit-funds", { amount: 21 }));

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ balance: 42 });
  });

  test("dispatches on the QueryBus", async () => {
    const result = await withServer(registrations, callTool("get-balance", { account: "acc-1" }));

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ balance: 7 });
  });

  test("a bad payload surfaces the bus's ValidationFailed message", async () => {
    const result = await withServer(registrations, callTool("deposit-funds", { amount: "nope" }));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("DepositFunds is invalid");
    expect(textOf(result)).toContain("amount");
  });

  test("a failing handler surfaces the domain error message", async () => {
    const result = await withServer(registrations, callTool("withdraw-funds", { amount: 100 }));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("insufficient funds");
  });
});

// --- resources ----------------------------------------------------------

describe("defineResource", () => {
  test("lists the resource with its metadata", async () => {
    const resources = await withServer(
      [Readme],
      Effect.map(McpServer.McpServer, (server) => server.resources),
    );

    const readme = resources.find((resource) => resource.uri === "app://readme");
    expect(readme?.name).toBe("README");
    expect(readme?.mimeType).toBe("text/markdown");
  });

  test("reads the resource content back", async () => {
    const result = await withServer(
      [Readme],
      Effect.flatMap(McpServer.McpServer, (server) => server.findResource("app://readme")),
    );

    expect(result.contents).toHaveLength(1);
    expect(result.contents[0]).toMatchObject({ uri: "app://readme", text: "# hello" });
  });

  test("a failing read surfaces an InternalError with the message only", async () => {
    const error = await withServer(
      [Broken],
      Effect.flip(
        Effect.flatMap(McpServer.McpServer, (server) => server.findResource("app://broken")),
      ),
    );

    expect(error._tag).toBe("InternalError");
    expect(error.message).toContain("storage unavailable");
  });
});

// --- HTTP transport (full JSON-RPC wire, in-process server) -------------

describe("httpLayer", () => {
  const wireStack = Layer.mergeAll(
    httpLayer({
      name: "test-server",
      version: "0.0.0",
      path: "/mcp",
      tools: [Add],
      resources: [Readme],
    }),
    HttpRouter.Default.serve(),
  ).pipe(Layer.provideMerge(BunHttpServer.layerTest));

  const rpc = (method: string, params: unknown) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.post("/mcp", {
        body: HttpBody.unsafeJson({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const json = yield* response.json;
      const messages: ReadonlyArray<unknown> = Array.isArray(json) ? json : [json];
      const first = messages[0] as
        | { readonly result?: unknown; readonly error?: { readonly message?: string } }
        | undefined;
      if (first === undefined) throw new Error("no JSON-RPC response");
      return first;
    }).pipe(Effect.scoped);

  test("serves tools/list and tools/call over JSON-RPC", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const listed = yield* rpc("tools/list", {});
        const tools = (
          listed.result as { readonly tools: ReadonlyArray<{ readonly name: string }> }
        ).tools;
        expect(tools.map((tool) => tool.name)).toContain("add");

        const called = yield* rpc("tools/call", { name: "add", arguments: { a: 2, b: 3 } });
        const result = called.result as {
          readonly isError: boolean;
          readonly structuredContent: unknown;
        };
        expect(result.isError).toBe(false);
        expect(result.structuredContent).toEqual({ sum: 5 });
      }).pipe(Effect.provide(wireStack)),
    );
  });

  test("serves resources/read over JSON-RPC", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const read = yield* rpc("resources/read", { uri: "app://readme" });
        const contents = (
          read.result as { readonly contents: ReadonlyArray<{ readonly text?: string }> }
        ).contents;
        expect(contents[0]?.text).toBe("# hello");
      }).pipe(Effect.provide(wireStack)),
    );
  });
});
