import { Tool as AiTool } from "@effect/ai";
import {
  CommandBus,
  type CommandDefinition,
  QueryBus,
  type QueryDefinition,
} from "@structure-ai/cqrs";
import { Effect, Schema } from "effect";
import { makeToolLayer, type ToolLayer } from "./tool.js";

/** Optional overrides when exposing a CQRS message as an MCP tool. */
export interface BridgeToolOptions {
  /** Tool name; defaults to the kebab-cased message tag. */
  readonly name?: string | undefined;
  /** Tool description; defaults to the payload schema's description annotation. */
  readonly description?: string | undefined;
}

/** "ApproveInvoice" → "approve-invoice", "HTTPServer" → "http-server". */
const kebabCase = (tag: string): string =>
  tag
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

interface AnyDefinition {
  readonly _kind: "command" | "query";
  readonly tag: string;
  readonly payload: Schema.Schema.AnyNoContext;
  readonly success: Schema.Schema.AnyNoContext;
}

const bridge = <R>(
  definition: AnyDefinition,
  options: BridgeToolOptions | undefined,
  dispatch: (input: unknown) => Effect.Effect<unknown, unknown, R>,
): ToolLayer<R> => {
  const encode = Schema.encode(definition.success);
  return makeToolLayer<R>({
    name: options?.name ?? kebabCase(definition.tag),
    description:
      options?.description ??
      AiTool.getDescriptionFromSchemaAst(definition.payload.ast) ??
      `Dispatches the ${definition._kind} "${definition.tag}".`,
    parametersAst: definition.payload.ast,
    // The bus decodes the payload itself; raw arguments pass through so a bad
    // shape surfaces as the bus's ValidationFailed with its safe message.
    decodeParameters: Effect.succeed,
    encodeSuccess: (value) =>
      encode(value).pipe(
        Effect.mapError(
          (error) => `result encoding failed: ${error.message.split("\n")[0] ?? "unknown"}`,
        ),
      ),
    handler: dispatch,
  });
};

/**
 * Exposes a command definition as an MCP tool. The tool's parameters schema
 * is the command's payload schema; calls dispatch on the `CommandBus` from
 * context. `ValidationFailed` and domain failures become MCP tool errors
 * carrying only their `message`.
 */
export const toolFromCommand = <
  Tag extends string,
  PayloadType,
  PayloadEncoded,
  SuccessType,
  SuccessEncoded,
  FailureType,
  FailureEncoded,
>(
  definition: CommandDefinition<
    Tag,
    PayloadType,
    PayloadEncoded,
    SuccessType,
    SuccessEncoded,
    FailureType,
    FailureEncoded
  >,
  options?: BridgeToolOptions,
): ToolLayer<CommandBus> =>
  bridge(definition, options, (input) =>
    CommandBus.pipe(
      // The bus validates the raw arguments against the payload schema.
      Effect.flatMap((bus) => bus.dispatch(definition, input as PayloadEncoded)),
    ),
  );

/**
 * Exposes a query definition as an MCP tool dispatching on the `QueryBus`.
 * See {@link toolFromCommand} for validation and error shaping.
 */
export const toolFromQuery = <
  Tag extends string,
  PayloadType,
  PayloadEncoded,
  SuccessType,
  SuccessEncoded,
  FailureType,
  FailureEncoded,
>(
  definition: QueryDefinition<
    Tag,
    PayloadType,
    PayloadEncoded,
    SuccessType,
    SuccessEncoded,
    FailureType,
    FailureEncoded
  >,
  options?: BridgeToolOptions,
): ToolLayer<QueryBus> =>
  bridge(definition, options, (input) =>
    QueryBus.pipe(Effect.flatMap((bus) => bus.dispatch(definition, input as PayloadEncoded))),
  );
