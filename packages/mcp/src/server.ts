import { type McpSchema, McpServer } from "@effect/ai";
import { HttpRouter } from "@effect/platform";
import { BunHttpServer, BunRuntime, BunSink, BunStream } from "@effect/platform-bun";
import { RpcSerialization, RpcServer } from "@effect/rpc";
import { Effect, Layer, Logger } from "effect";
import {
  guard,
  type McpAuthOptions,
  metadataHandler,
  ToolScopes,
  validateResourceMetadata,
  wellKnownPaths,
} from "./auth.js";
import type { ResourceLayer } from "./resource.js";
import type { ToolLayer } from "./tool.js";

/** Composition of an MCP server: identity plus the capabilities it exposes. */
export interface McpAppOptions<RTools = never, RResources = never> {
  /** Server name reported to clients during the MCP `initialize` handshake. */
  readonly name: string;
  readonly version: string;
  readonly tools?: ReadonlyArray<ToolLayer<RTools>> | undefined;
  readonly resources?: ReadonlyArray<ResourceLayer<RResources>> | undefined;
}

/** Merges all capability registration layers (identity layer when empty). */
const capabilities = <RTools, RResources>(
  options: McpAppOptions<RTools, RResources>,
): Layer.Layer<never, never, RTools | RResources> => {
  const layers: ReadonlyArray<Layer.Layer<never, never, RTools | RResources>> = [
    ...(options.tools ?? []),
    ...(options.resources ?? []),
  ];
  const [head, ...tail] = layers;
  return head === undefined ? Layer.empty : Layer.mergeAll(head, ...tail);
};

/**
 * Transport-agnostic server layer: registers all capabilities and runs the
 * MCP request loop over whatever `RpcServer.Protocol` is provided. Prefer
 * {@link stdioLayer} or {@link httpLayer} unless wiring a custom transport.
 */
export const serverLayer = <RTools = never, RResources = never>(
  options: McpAppOptions<RTools, RResources>,
): Layer.Layer<
  McpServer.McpServer | McpSchema.McpServerClient,
  never,
  RTools | RResources | RpcServer.Protocol
> =>
  capabilities(options).pipe(
    Layer.provideMerge(McpServer.layer({ name: options.name, version: options.version })),
  );

/**
 * MCP server over stdio (newline-delimited JSON-RPC on stdin/stdout), the
 * transport local coding agents such as Claude Code use. Launch with
 * {@link runStdio} or `Layer.launch`.
 */
export const stdioLayer = <RTools = never, RResources = never>(
  options: McpAppOptions<RTools, RResources>,
): Layer.Layer<never, never, RTools | RResources> =>
  capabilities(options).pipe(
    Layer.provide(
      McpServer.layerStdio({
        name: options.name,
        version: options.version,
        stdin: BunStream.stdin,
        stdout: BunSink.stdout,
      }),
    ),
  );

/**
 * Runs the stdio server on the Bun runtime until interrupted. Logging is
 * redirected to stderr so stdout stays a clean MCP channel.
 */
export const runStdio = (options: McpAppOptions): void =>
  BunRuntime.runMain(
    Layer.launch(stdioLayer(options)).pipe(
      Effect.provide(Logger.replace(Logger.defaultLogger, Logger.prettyLogger({ stderr: true }))),
    ),
  );

/** {@link McpAppOptions} plus the route the HTTP transport is mounted on. */
export interface McpHttpOptions<RTools = never, RResources = never, EAuth = unknown, RAuth = never>
  extends McpAppOptions<RTools, RResources> {
  /** Route to mount the MCP endpoint on, e.g. `"/mcp"`. */
  readonly path: HttpRouter.PathInput;
  /**
   * OAuth 2.1 resource-server guard (see {@link McpAuthOptions}). When set,
   * every request on `path` needs a verified bearer token, `401`/`403`
   * answers carry the RFC 6750 / 9728 `WWW-Authenticate` challenge, and the
   * protected resource metadata is served at `/.well-known/oauth-protected-resource`
   * (plus the path-suffixed variant for a non-root resource).
   */
  readonly auth?: McpAuthOptions<EAuth, RAuth> | undefined;
}

/**
 * The library's HTTP protocol with the bearer guard in front of the MCP route
 * and the metadata documents beside it. Mirrors `RpcServer.layerProtocolHttp`
 * on the default router; the verifier's services are captured at build time.
 */
const guardedProtocol = <EAuth, RAuth>(
  path: HttpRouter.PathInput,
  auth: McpAuthOptions<EAuth, RAuth>,
): Layer.Layer<RpcServer.Protocol, never, RAuth> =>
  Layer.effect(
    RpcServer.Protocol,
    Effect.gen(function* () {
      yield* validateResourceMetadata(auth.resourceMetadata);
      const { httpApp, protocol } = yield* RpcServer.makeProtocolWithHttpApp;
      const router = yield* HttpRouter.Default;
      const scopes = yield* ToolScopes;
      yield* scopes.setDefault(auth.defaultScopes);
      const context = yield* Effect.context<RAuth>();
      yield* router.post(path, guard(auth, scopes, context)(httpApp));
      for (const wellKnown of wellKnownPaths(auth.resourceMetadata)) {
        yield* router.get(wellKnown, metadataHandler(auth.resourceMetadata));
      }
      return protocol;
    }),
  ).pipe(
    Layer.provide(HttpRouter.Default.Live),
    Layer.provide(ToolScopes.layer),
    Layer.provide(RpcSerialization.layerJsonRpc()),
  );

/**
 * MCP server over HTTP (JSON-RPC POST endpoint), using @effect/ai's HTTP
 * transport on the default `HttpRouter`. Serve it by merging with
 * `HttpRouter.Default.serve()` and providing an HTTP server — or use
 * {@link httpServerLayer} for the batteries-included Bun stack. With `auth`
 * set, the endpoint is an OAuth 2.1 protected resource (see {@link McpHttpOptions.auth}).
 */
export const httpLayer = <RTools = never, RResources = never, EAuth = unknown, RAuth = never>(
  options: McpHttpOptions<RTools, RResources, EAuth, RAuth>,
): Layer.Layer<never, never, RTools | RResources | RAuth> =>
  capabilities(options).pipe(
    Layer.provide(
      options.auth === undefined
        ? McpServer.layerHttp({ name: options.name, version: options.version, path: options.path })
        : McpServer.layer({ name: options.name, version: options.version }).pipe(
            Layer.provide(guardedProtocol(options.path, options.auth)),
          ),
    ),
  );

/**
 * Complete HTTP stack: {@link httpLayer} served by a Bun HTTP server on the
 * given port. Launch with {@link runHttp} or `Layer.launch`.
 */
export const httpServerLayer = <RTools = never, RResources = never, EAuth = unknown, RAuth = never>(
  options: McpHttpOptions<RTools, RResources, EAuth, RAuth> & { readonly port: number },
): Layer.Layer<never, never, RTools | RResources | RAuth> =>
  Layer.mergeAll(httpLayer(options), HttpRouter.Default.serve()).pipe(
    Layer.provide(BunHttpServer.layer({ port: options.port })),
  );

/** Runs the HTTP server on the Bun runtime until interrupted. */
export const runHttp = (options: McpHttpOptions & { readonly port: number }): void =>
  BunRuntime.runMain(Layer.launch(httpServerLayer(options)));
