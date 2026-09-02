import { Tool as AiTool, McpSchema, McpServer } from "@effect/ai";
import { Effect, Layer, Predicate, Schema } from "effect";
import { ArrayFormatter, type ParseError } from "effect/ParseResult";
import {
  InsufficientScope,
  McpPrincipal,
  recordVerdict,
  scopeVerdict,
  ToolScopes,
} from "./auth.js";

/**
 * A registered MCP capability, following @effect/ai's layer-driven grain:
 * building the layer registers the tool (or resource) with the memoized
 * `McpServer`. Merge these and provide a transport layer from `server.ts`.
 */
export type ToolLayer<R = never> = Layer.Layer<never, never, R>;

/** Parameters accepted by {@link defineTool}: struct fields or a struct schema. */
export type ToolParametersInput = Schema.Struct.Fields | Schema.Schema.AnyNoContext;

/** Resolves the parameters input to the schema the handler is typed against. */
export type ToolParametersSchema<P extends ToolParametersInput> =
  P extends Schema.Schema.AnyNoContext
    ? P
    : P extends Schema.Struct.Fields
      ? Schema.Struct<P>
      : never;

const formatParseIssues = (error: ParseError): string =>
  ArrayFormatter.formatErrorSync(error)
    .map((issue) =>
      issue.path.length === 0 ? issue.message : `${issue.path.join(".")}: ${issue.message}`,
    )
    .join("; ");

/**
 * Extracts a safe, human-readable message from a failed tool execution.
 * Prefers the error's `message` (all framework errors define one); never
 * includes a stack trace.
 */
const errorMessage = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { readonly message: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
};

const successResult = (encoded: unknown): McpSchema.CallToolResult =>
  new McpSchema.CallToolResult({
    isError: false,
    structuredContent: Predicate.isRecord(encoded) ? encoded : undefined,
    content: [{ type: "text", text: JSON.stringify(encoded === undefined ? null : encoded) }],
  });

const errorResult = (message: string): McpSchema.CallToolResult =>
  new McpSchema.CallToolResult({
    isError: true,
    content: [{ type: "text", text: message }],
  });

/**
 * Type-erased tool specification shared by {@link defineTool} and the CQRS
 * bridge. Internal to @structure-ai/mcp.
 */
export interface ErasedToolSpec<R> {
  readonly name: string;
  readonly description: string | undefined;
  /** Declared OAuth scopes; `undefined` inherits the guard's `defaultScopes`, `[]` opts out. */
  readonly scopes: ReadonlyArray<string> | undefined;
  /** AST used to derive the JSON `inputSchema` advertised on `tools/list`. */
  readonly parametersAst: Schema.Schema.AnyNoContext["ast"];
  /** Validates raw `tools/call` arguments; failures are already message-shaped. */
  readonly decodeParameters: (input: unknown) => Effect.Effect<unknown, string>;
  /** Encodes the handler success to a JSON-friendly value. */
  readonly encodeSuccess: (value: unknown) => Effect.Effect<unknown, string>;
  readonly handler: (params: unknown) => Effect.Effect<unknown, unknown, R>;
}

const register = <R>(
  spec: ErasedToolSpec<R>,
): Effect.Effect<void, never, McpServer.McpServer | ToolScopes | R> =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const scopes = yield* ToolScopes;
    const context = yield* Effect.context<R>();
    yield* scopes.register(spec.name, spec.scopes);
    // Asserted at dispatch on every transport from the same required/granted
    // sets as the HTTP guard, and recorded once per call (the guard records
    // only what it refuses before reaching here).
    const authorize = Effect.gen(function* () {
      const principal = yield* McpPrincipal.current;
      const verdict = scopeVerdict(spec.name, scopes.requiredFor(spec.name), principal);
      yield* recordVerdict(verdict);
      if (verdict.outcome !== "allowed") {
        return yield* Effect.fail(new InsufficientScope({ verdict }).message);
      }
    });
    yield* server.addTool({
      tool: new McpSchema.Tool({
        name: spec.name,
        inputSchema: AiTool.getJsonSchemaFromSchemaAst(spec.parametersAst),
        ...(spec.description !== undefined && { description: spec.description }),
      }),
      // Errors and defects become MCP *tool* errors (`isError: true`) carrying
      // only the error's message, so the calling agent can see and self-correct.
      handle: (payload: unknown) =>
        authorize.pipe(
          Effect.zipRight(spec.decodeParameters(payload)),
          Effect.flatMap((params) =>
            spec
              .handler(params)
              .pipe(
                Effect.provide(context),
                Effect.mapError(errorMessage),
                Effect.flatMap(spec.encodeSuccess),
              ),
          ),
          Effect.map(successResult),
          Effect.catchAll((message) => Effect.succeed(errorResult(message))),
          Effect.catchAllDefect((defect) => Effect.succeed(errorResult(errorMessage(defect)))),
        ),
    });
  });

/**
 * Registers a type-erased tool spec with the shared `McpServer`. Internal
 * building block for {@link defineTool} and `bridge.ts`.
 */
export const makeToolLayer = <R>(spec: ErasedToolSpec<R>): ToolLayer<R> =>
  Layer.effectDiscard(register(spec)).pipe(
    Layer.provide(McpServer.McpServer.layer),
    Layer.provide(ToolScopes.layer),
  ) as ToolLayer<R>;

/** Options for {@link defineTool}. */
export interface DefineToolOptions<
  Name extends string,
  P extends ToolParametersInput,
  S extends Schema.Schema.AnyNoContext,
  E,
  R,
> {
  readonly name: Name;
  readonly description?: string | undefined;
  /**
   * OAuth scopes a caller must hold (all of them), asserted at dispatch
   * against the principal attached by the HTTP bearer guard (`403
   * insufficient_scope`) or by `McpPrincipal.within`; with a non-empty
   * requirement and no principal the tool refuses to run. Undeclared inherits
   * the guard's `defaultScopes`; `[]` opts the tool out explicitly.
   */
  readonly scopes?: ReadonlyArray<string> | undefined;
  /** Struct fields or a struct schema validating `tools/call` arguments. */
  readonly parameters: P;
  /** Schema of the handler result; its encoded side is what agents receive. */
  readonly success: S;
  readonly handler: (
    params: Schema.Schema.Type<ToolParametersSchema<P>>,
  ) => Effect.Effect<Schema.Schema.Type<S>, E, R>;
}

/**
 * Defines an MCP tool with Schema-validated parameters and success value.
 *
 * The returned layer registers the tool with the `McpServer` from @effect/ai;
 * compose it via `server.ts`. Conventions applied on top of the library:
 *
 * - arguments are decoded with the parameters schema; invalid input produces
 *   an MCP tool error (`isError: true`), not a protocol crash;
 * - the success value is encoded with the success schema (JSON-friendly);
 * - handler failures and defects become tool errors carrying the error's
 *   `message` only — never a stack trace or internals;
 * - declared `scopes` are checked before the handler runs (see
 *   {@link DefineToolOptions.scopes}).
 */
export const defineTool = <
  const Name extends string,
  P extends ToolParametersInput,
  S extends Schema.Schema.AnyNoContext,
  E,
  R = never,
>(
  options: DefineToolOptions<Name, P, S, E, R>,
): ToolLayer<R> => {
  const parameters: Schema.Schema.AnyNoContext = Schema.isSchema(options.parameters)
    ? (options.parameters as Schema.Schema.AnyNoContext)
    : // `Struct<Fields>` types its context as `unknown`; tool parameter
      // schemas must be context-free, so the erasure to `AnyNoContext` is safe.
      (Schema.Struct(
        options.parameters as Schema.Struct.Fields,
      ) as unknown as Schema.Schema.AnyNoContext);
  const decode = Schema.decodeUnknown(parameters, { errors: "all" });
  const encode = Schema.encode(options.success);
  return makeToolLayer<R>({
    name: options.name,
    description: options.description,
    scopes: options.scopes,
    parametersAst: parameters.ast,
    decodeParameters: (input) =>
      decode(input).pipe(
        Effect.mapError((error) => `invalid parameters: ${formatParseIssues(error)}`),
      ),
    encodeSuccess: (value) =>
      encode(value).pipe(
        Effect.mapError((error) => `result encoding failed: ${formatParseIssues(error)}`),
      ),
    handler: options.handler as (params: unknown) => Effect.Effect<unknown, unknown, R>,
  });
};
