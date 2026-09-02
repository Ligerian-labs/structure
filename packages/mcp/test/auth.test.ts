import { describe, expect, test } from "bun:test";
import { type McpSchema, McpServer } from "@effect/ai";
import { HttpBody, HttpClient, HttpRouter } from "@effect/platform";
import { BunHttpServer } from "@effect/platform-bun";
import {
  Data,
  Effect,
  FiberRef,
  HashMap,
  HashSet,
  Layer,
  Logger,
  Option,
  Redacted,
  Schema,
} from "effect";
import {
  defineTool,
  httpLayer,
  InsufficientScope,
  type McpAuthOptions,
  McpPrincipal,
  ProtectedResourceMetadata,
  protectedResourceMetadata,
  resourceMetadataUrl,
  scopeVerdict,
} from "../src/index.js";

// --- fixtures -----------------------------------------------------------

/** A verifier failure whose message must never reach the wire. */
class TokenRejected extends Data.TaggedError("TokenRejected")<{ readonly detail: string }> {
  readonly classification = "permanent";
  override get message(): string {
    return `verifier internals: ${this.detail}`;
  }
}

const principals: Record<string, McpPrincipal> = {
  bare: { id: "user-bare", roles: [], kind: "user", scopes: [] },
  reader: { id: "user-reader", roles: ["viewer"], kind: "user", scopes: ["invoices:read"] },
  writer: {
    id: "user-writer",
    roles: ["manager"],
    kind: "user",
    scopes: ["invoices:read", "invoices:write"],
  },
};

/** Simulates `Principal.within` from @structure-ai/authorization. */
const actorRef = FiberRef.unsafeMake<string>("nobody");

const auth: McpAuthOptions<TokenRejected> = {
  verify: (token) => {
    const principal = principals[Redacted.value(token)];
    return principal === undefined
      ? Effect.fail(new TokenRejected({ detail: "signature mismatch on kid=k1" }))
      : Effect.succeed(principal);
  },
  within: (principal) => Effect.locally(actorRef, principal.id),
  resourceMetadata: {
    resource: "http://localhost/mcp",
    authorizationServers: ["http://localhost/oauth"],
    scopesSupported: ["invoices:read", "invoices:write"],
    resourceName: "Billing MCP",
  },
};

const WhoAmI = defineTool({
  name: "whoami",
  description: "Reports the current principal.",
  parameters: {},
  success: Schema.Struct({ id: Schema.String, actor: Schema.String }),
  handler: () =>
    Effect.gen(function* () {
      const principal = yield* McpPrincipal.current;
      const actor = yield* FiberRef.get(actorRef);
      return { id: Option.match(principal, { onNone: () => "none", onSome: (p) => p.id }), actor };
    }),
});

const Approve = defineTool({
  name: "approve-invoice",
  description: "Approves an invoice.",
  parameters: { id: Schema.String },
  success: Schema.Struct({ approved: Schema.String }),
  scopes: ["invoices:write"],
  handler: ({ id }) => Effect.succeed({ approved: id }),
});

const Open = defineTool({
  name: "open",
  description: "Explicitly unscoped.",
  parameters: {},
  success: Schema.Struct({ ok: Schema.Boolean }),
  scopes: [],
  handler: () => Effect.succeed({ ok: true }),
});

// --- harness ------------------------------------------------------------

const stackFor = (options: McpAuthOptions<TokenRejected>) =>
  Layer.mergeAll(
    httpLayer({
      name: "guarded",
      version: "0.0.0",
      path: "/mcp",
      auth: options,
      tools: [WhoAmI, Approve, Open],
    }),
    HttpRouter.Default.serve(),
  ).pipe(Layer.provideMerge(BunHttpServer.layerTest));

const wireStack = stackFor(auth);

interface Wire {
  readonly status: number;
  readonly challenge: string | undefined;
  readonly body: unknown;
}

const post = (
  path: string,
  token: string | undefined,
  method: string,
  params: unknown,
): Effect.Effect<Wire, unknown, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.post(path, {
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
      body: HttpBody.unsafeJson({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body: unknown = yield* response.json;
    return {
      status: response.status,
      challenge: response.headers["www-authenticate"],
      body,
    };
  }).pipe(Effect.scoped);

const get = (path: string): Effect.Effect<Wire, unknown, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(path);
    const body: unknown = yield* response.json;
    return { status: response.status, challenge: response.headers["www-authenticate"], body };
  }).pipe(Effect.scoped);

const run = <A>(
  effect: Effect.Effect<A, unknown, HttpClient.HttpClient>,
  stack: Layer.Layer<HttpClient.HttpClient, unknown> = wireStack,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(stack)));

const rpcResult = (wire: Wire): { readonly result?: unknown; readonly error?: unknown } => {
  const messages: ReadonlyArray<unknown> = Array.isArray(wire.body) ? wire.body : [wire.body];
  const first = messages[0];
  if (typeof first !== "object" || first === null) throw new Error("no JSON-RPC response");
  return first as { readonly result?: unknown; readonly error?: unknown };
};

const toolResult = (
  wire: Wire,
): { readonly isError: boolean; readonly structuredContent: unknown } =>
  rpcResult(wire).result as { readonly isError: boolean; readonly structuredContent: unknown };

// --- bearer guard -------------------------------------------------------

describe("httpLayer with auth: bearer guard", () => {
  test("no token → 401 with the RFC 9728 challenge and no error code", async () => {
    const wire = await run(post("/mcp", undefined, "tools/list", {}));

    expect(wire.status).toBe(401);
    expect(wire.challenge).toBe(
      'Bearer resource_metadata="http://localhost/.well-known/oauth-protected-resource/mcp"',
    );
    expect(wire.body).toMatchObject({ error: "unauthorized" });
  });

  test("bad token → 401 invalid_token, verifier internals never leak", async () => {
    const wire = await run(post("/mcp", "forged", "tools/list", {}));

    expect(wire.status).toBe(401);
    expect(wire.challenge).toContain('error="invalid_token"');
    expect(wire.challenge).toContain(
      'resource_metadata="http://localhost/.well-known/oauth-protected-resource/mcp"',
    );
    expect(wire.body).toMatchObject({ error: "invalid_token" });
    expect(JSON.stringify(wire.body)).not.toContain("verifier internals");
    expect(JSON.stringify(wire.body)).not.toContain("kid=k1");
    expect(wire.challenge).not.toContain("kid=k1");
  });

  test("malformed Authorization header is treated as no token", async () => {
    const wire = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const response = yield* client.post("/mcp", {
          headers: { authorization: "Basic dXNlcjpwYXNz" },
          body: HttpBody.unsafeJson({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
        });
        return { status: response.status, challenge: response.headers["www-authenticate"] };
      }).pipe(Effect.scoped, Effect.provide(wireStack)),
    );

    expect(wire.status).toBe(401);
    expect(wire.challenge).not.toContain("error=");
  });

  test("good token → the tool runs with the principal on the fiber and the within hook applied", async () => {
    const wire = await run(post("/mcp", "reader", "tools/call", { name: "whoami", arguments: {} }));

    expect(wire.status).toBe(200);
    const result = toolResult(wire);
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ id: "user-reader", actor: "user-reader" });
  });

  test("good token → tools/list is served", async () => {
    const wire = await run(post("/mcp", "reader", "tools/list", {}));

    expect(wire.status).toBe(200);
    const tools = (rpcResult(wire).result as { readonly tools: ReadonlyArray<{ name: string }> })
      .tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual(["approve-invoice", "open", "whoami"]);
  });

  test("token lacking a declared scope → 403 insufficient_scope naming the missing scope", async () => {
    const wire = await run(
      post("/mcp", "reader", "tools/call", { name: "approve-invoice", arguments: { id: "inv-1" } }),
    );

    expect(wire.status).toBe(403);
    expect(wire.challenge).toContain('error="insufficient_scope"');
    expect(wire.challenge).toContain('scope="invoices:write"');
    expect(wire.challenge).toContain(
      'resource_metadata="http://localhost/.well-known/oauth-protected-resource/mcp"',
    );
    expect(wire.body).toMatchObject({ error: "insufficient_scope", scope: "invoices:write" });
  });

  test("token holding the declared scope → the scoped tool runs", async () => {
    const wire = await run(
      post("/mcp", "writer", "tools/call", { name: "approve-invoice", arguments: { id: "inv-1" } }),
    );

    expect(wire.status).toBe(200);
    expect(toolResult(wire).structuredContent).toEqual({ approved: "inv-1" });
  });

  test("the verifier sees the request and its services", async () => {
    class Tenants extends Effect.Tag("Tenants")<Tenants, { readonly current: string }>() {}
    const seen: Array<string> = [];
    const stack = Layer.mergeAll(
      httpLayer({
        name: "guarded",
        version: "0.0.0",
        path: "/mcp",
        auth: {
          verify: (token, request) =>
            Effect.gen(function* () {
              const tenants = yield* Tenants;
              seen.push(`${request.headers.host ?? "?"}:${tenants.current}`);
              return Redacted.value(token) === "ok"
                ? { id: "svc", roles: [] as ReadonlyArray<string> }
                : yield* Effect.fail("nope");
            }),
          resourceMetadata: {
            resource: "http://localhost/mcp",
            authorizationServers: ["http://as"],
          },
        },
        tools: [WhoAmI],
      }).pipe(Layer.provide(Layer.succeed(Tenants, { current: "acme" }))),
      HttpRouter.Default.serve(),
    ).pipe(Layer.provideMerge(BunHttpServer.layerTest));

    const wire = await run(
      post("/mcp", "ok", "tools/call", { name: "whoami", arguments: {} }),
      stack,
    );

    expect(wire.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/:acme$/);
  });
});

// --- default scopes (fail closed on undeclared tools) ---------------------

describe("httpLayer with auth: defaultScopes", () => {
  const stack = stackFor({ ...auth, defaultScopes: ["invoices:read"] });

  test("a tool declaring no scopes inherits defaultScopes: a token lacking them → 403", async () => {
    const wire = await run(
      post("/mcp", "bare", "tools/call", { name: "whoami", arguments: {} }),
      stack,
    );

    expect(wire.status).toBe(403);
    expect(wire.challenge).toContain('error="insufficient_scope"');
    expect(wire.challenge).toContain('scope="invoices:read"');
    expect(wire.body).toMatchObject({ error: "insufficient_scope", scope: "invoices:read" });
  });

  test("a token holding the default scopes runs the undeclared tool", async () => {
    const wire = await run(
      post("/mcp", "reader", "tools/call", { name: "whoami", arguments: {} }),
      stack,
    );

    expect(wire.status).toBe(200);
    expect(toolResult(wire).structuredContent).toEqual({ id: "user-reader", actor: "user-reader" });
  });

  test("declared scopes replace the defaults rather than adding to them", async () => {
    const wire = await run(
      post("/mcp", "writer", "tools/call", { name: "approve-invoice", arguments: { id: "inv-2" } }),
      stack,
    );

    expect(wire.status).toBe(200);
  });

  test("scopes: [] is an explicit opt-out", async () => {
    const wire = await run(
      post("/mcp", "bare", "tools/call", { name: "open", arguments: {} }),
      stack,
    );

    expect(wire.status).toBe(200);
    expect(toolResult(wire).structuredContent).toEqual({ ok: true });
  });

  test("without defaultScopes an undeclared tool is guarded by the bearer check only", async () => {
    const wire = await run(post("/mcp", "bare", "tools/call", { name: "whoami", arguments: {} }));

    expect(wire.status).toBe(200);
  });
});

// --- protected resource metadata (RFC 9728) ------------------------------

describe("httpLayer with auth: protected resource metadata", () => {
  test("GET the path-suffixed well-known document, unauthenticated", async () => {
    const wire = await run(get("/.well-known/oauth-protected-resource/mcp"));

    expect(wire.status).toBe(200);
    const document = Schema.decodeUnknownSync(ProtectedResourceMetadata)(wire.body);
    expect(document).toEqual({
      resource: "http://localhost/mcp",
      authorization_servers: ["http://localhost/oauth"],
      scopes_supported: ["invoices:read", "invoices:write"],
      bearer_methods_supported: ["header"],
      resource_name: "Billing MCP",
    });
  });

  test("GET the root well-known document serves the same document", async () => {
    const suffixed = await run(get("/.well-known/oauth-protected-resource/mcp"));
    const root = await run(get("/.well-known/oauth-protected-resource"));

    expect(root.status).toBe(200);
    expect(root.body).toEqual(suffixed.body);
  });

  test("a root resource serves only the root well-known document and challenges with it", async () => {
    const stack = stackFor({
      ...auth,
      resourceMetadata: { resource: "http://localhost", authorizationServers: ["http://as"] },
    });

    const root = await run(get("/.well-known/oauth-protected-resource"), stack);
    const challenge = await run(post("/mcp", undefined, "tools/list", {}), stack);

    expect(root.status).toBe(200);
    expect(Schema.decodeUnknownSync(ProtectedResourceMetadata)(root.body).resource).toBe(
      "http://localhost",
    );
    expect(challenge.challenge).toBe(
      'Bearer resource_metadata="http://localhost/.well-known/oauth-protected-resource"',
    );
  });

  test("the document schema rejects a missing resource identifier", () => {
    expect(() =>
      Schema.decodeUnknownSync(ProtectedResourceMetadata)({ authorization_servers: ["x"] }),
    ).toThrow();
  });

  test("protectedResourceMetadata / resourceMetadataUrl derive from the resource identifier", () => {
    const options = {
      resource: "https://api.example.com/agents/mcp/",
      authorizationServers: ["https://auth.example.com"],
    };
    expect(resourceMetadataUrl(options)).toBe(
      "https://api.example.com/.well-known/oauth-protected-resource/agents/mcp",
    );
    expect(protectedResourceMetadata(options)).toEqual({
      resource: "https://api.example.com/agents/mcp/",
      authorization_servers: ["https://auth.example.com"],
      bearer_methods_supported: ["header"],
    });
  });
});

// --- tool-level scope enforcement (any transport) ------------------------

describe("tool scopes outside the HTTP guard", () => {
  const withServer = <A, E>(
    registrations: ReadonlyArray<Layer.Layer<never>>,
    effect: Effect.Effect<A, E, McpServer.McpServer | McpSchema.McpServerClient>,
  ): Promise<A> =>
    Effect.runPromise(
      effect.pipe(Effect.provide(Layer.mergeAll(McpServer.McpServer.layer, ...registrations))),
    );

  const callTool = (name: string, args: Record<string, unknown>) =>
    Effect.flatMap(McpServer.McpServer, (server) => server.callTool({ name, arguments: args }));

  const textOf = (result: McpSchema.CallToolResult): string => {
    const block = result.content[0];
    if (block === undefined || block.type !== "text") throw new Error("expected text content");
    return block.text;
  };

  test("no principal → tool error unauthenticated (fail closed)", async () => {
    const result = await withServer([Approve], callTool("approve-invoice", { id: "inv-1" }));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("unauthenticated");
    expect(textOf(result)).toContain("invoices:write");
  });

  test("principal lacking the scope → tool error insufficient_scope", async () => {
    const reader = principals.reader;
    if (reader === undefined) throw new Error("fixture");
    const result = await withServer(
      [Approve],
      callTool("approve-invoice", { id: "inv-1" }).pipe(McpPrincipal.within(reader)),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("insufficient_scope");
  });

  test("principal holding the scope → the tool runs", async () => {
    const writer = principals.writer;
    if (writer === undefined) throw new Error("fixture");
    const result = await withServer(
      [Approve],
      callTool("approve-invoice", { id: "inv-1" }).pipe(McpPrincipal.within(writer)),
    );

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ approved: "inv-1" });
  });

  test("a denied call logs one verdict listing exactly the missing scopes", async () => {
    const reader = principals.reader;
    if (reader === undefined) throw new Error("fixture");
    const entries: Array<Record<string, unknown>> = [];
    const capture = Logger.make(({ logLevel, message, annotations }) => {
      entries.push({
        level: logLevel.label,
        message: Array.isArray(message) ? message[0] : message,
        ...Object.fromEntries(HashMap.toEntries(annotations)),
      });
    });

    await withServer(
      [Approve],
      callTool("approve-invoice", { id: "inv-1" }).pipe(
        McpPrincipal.within(reader),
        Effect.annotateLogs("correlationId", "corr-1"),
        Effect.locally(FiberRef.currentLoggers, HashSet.make(capture)),
      ),
    );

    const verdicts = entries.filter((entry) => entry.message === "mcp: scope verdict");
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({
      level: "WARN",
      tool: "approve-invoice",
      principal: "user-reader",
      outcome: "insufficient_scope",
      requiredScopes: ["invoices:write"],
      grantedScopes: ["invoices:read"],
      missingScopes: ["invoices:write"],
      correlationId: "corr-1",
    });
    expect(JSON.stringify(verdicts[0])).not.toContain("Bearer");
  });

  test("scopeVerdict computes required ⊆ granted from the same sets the guards use", () => {
    const writer = principals.writer;
    if (writer === undefined) throw new Error("fixture");
    expect(scopeVerdict("t", ["invoices:write"], Option.some(writer))).toEqual({
      tool: "t",
      principal: "user-writer",
      requiredScopes: ["invoices:write"],
      grantedScopes: ["invoices:read", "invoices:write"],
      missingScopes: [],
      outcome: "allowed",
    });
    expect(
      scopeVerdict("t", ["a", "b"], Option.some({ id: "p", roles: [], scopes: ["a"] })),
    ).toMatchObject({ missingScopes: ["b"], outcome: "insufficient_scope" });
    expect(scopeVerdict("t", ["a"], Option.none())).toMatchObject({
      principal: undefined,
      grantedScopes: [],
      missingScopes: ["a"],
      outcome: "unauthenticated",
    });
    expect(scopeVerdict("t", [], Option.none()).outcome).toBe("allowed");
  });

  test("InsufficientScope is a permanent tagged error carrying the verdict", () => {
    const error = new InsufficientScope({
      verdict: scopeVerdict("t", ["a", "b"], Option.some({ id: "p", roles: [], scopes: ["a"] })),
    });
    expect(error._tag).toBe("InsufficientScope");
    expect(error.classification).toBe("permanent");
    expect(error.missing).toEqual(["b"]);
    expect(error.message).toBe('insufficient_scope: tool "t" requires scope(s) "b"');
  });
});
