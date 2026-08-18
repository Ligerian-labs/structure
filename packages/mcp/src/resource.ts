import { type McpSchema, McpServer } from "@effect/ai";
import type { Effect, Layer } from "effect";

/**
 * A registered MCP resource; same layer-driven grain as tools. Merge into a
 * server composition from `server.ts`.
 */
export type ResourceLayer<R = never> = Layer.Layer<never, never, R>;

/** Content a resource read may produce, as accepted by @effect/ai. */
export type ResourceContent = string | Uint8Array | typeof McpSchema.ReadResourceResult.Type;

/** Options for {@link defineResource}. */
export interface DefineResourceOptions<E, R> {
  /** Stable URI the resource is listed and read under (e.g. `app://readme`). */
  readonly uri: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly mimeType?: string | undefined;
  /**
   * Produces the resource content on `resources/read`. A plain string (or
   * `Uint8Array` for binary content) is wrapped into the MCP result; failures
   * surface as an MCP internal error carrying only the error's message.
   */
  readonly read: Effect.Effect<ResourceContent, E, R>;
}

/**
 * Defines an MCP resource, mapped to @effect/ai's `McpServer.resource`
 * registration. The returned layer registers the resource with the shared
 * `McpServer`; compose it via `server.ts`.
 */
export const defineResource = <E, R>(
  options: DefineResourceOptions<E, R>,
): ResourceLayer<Exclude<R, McpSchema.McpServerClient>> =>
  McpServer.resource({
    uri: options.uri,
    name: options.name,
    description: options.description,
    mimeType: options.mimeType,
    content: options.read,
  });
