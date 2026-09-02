import { type HttpApp, HttpServerRequest, HttpServerResponse } from "@effect/platform";
import {
  Context,
  Data,
  Effect,
  Either,
  FiberRef,
  Layer,
  Option,
  Redacted,
  Schema,
  type Scope,
} from "effect";
import { globalValue } from "effect/GlobalValue";

// --- principal ------------------------------------------------------------------

/** A role held only inside one scope (tenant, organisation, project…). */
export interface McpRoleAssignment {
  readonly role: string;
  readonly scope: string;
}

/**
 * Who is calling the MCP server, as established by the bearer verifier.
 * Structurally identical to `Principal` from `@structure-ai/authorization`
 * (this package never depends on it), so the same value can be handed to
 * `Principal.within` through {@link McpAuthOptions.within} and every policy
 * guard downstream sees it. `scopes` are the OAuth scopes the token grants;
 * a tool declaring `scopes` refuses principals that lack any of them.
 */
export interface McpPrincipal {
  readonly id: string;
  readonly roles: ReadonlyArray<string | McpRoleAssignment>;
  readonly kind?: "user" | "service" | "anonymous";
  readonly tenantId?: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
  readonly scopes?: ReadonlyArray<string>;
}

const principalRef = globalValue("@structure-ai/mcp/Principal", () =>
  FiberRef.unsafeMake<Option.Option<McpPrincipal>>(Option.none()),
);

/** The principal attached to the current fiber, if any. */
const current: Effect.Effect<Option.Option<McpPrincipal>> = FiberRef.get(principalRef);

/**
 * Runs an effect on behalf of a principal for this package's own checks (tool
 * `scopes`, {@link McpPrincipal.current}). The HTTP guard applies it around
 * every request; apply it yourself around `Layer.launch(stdioLayer(...))` when
 * a stdio server exposes scoped tools to a locally trusted agent.
 */
const within =
  (principal: McpPrincipal) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.locally(principalRef, Option.some(principal))(effect);

/** Principal accessors scoped to this package (see {@link McpPrincipal}). */
export const McpPrincipal = { current, within } as const;

// --- scope verdict --------------------------------------------------------------

/**
 * The per-call grant decision: what the tool required, what the principal
 * held, what was missing, and the outcome. Computed at dispatch (HTTP guard
 * and tool handler alike, from the same sets) and recorded as one structured
 * log line per guarded call — enough to recompute the `401`/`403` later.
 */
export interface ScopeVerdict {
  readonly tool: string;
  /** Subject id of the principal; `undefined` when none is attached. */
  readonly principal: string | undefined;
  readonly requiredScopes: ReadonlyArray<string>;
  readonly grantedScopes: ReadonlyArray<string>;
  /** `requiredScopes` minus `grantedScopes`; empty when allowed. */
  readonly missingScopes: ReadonlyArray<string>;
  readonly outcome: "allowed" | "insufficient_scope" | "unauthenticated";
}

/** Asserts `required ⊆ granted` for the principal (none attached → nothing granted). */
export const scopeVerdict = (
  tool: string,
  required: ReadonlyArray<string>,
  principal: Option.Option<McpPrincipal>,
): ScopeVerdict => {
  const granted = Option.match(principal, {
    onNone: (): ReadonlyArray<string> => [],
    onSome: (p) => p.scopes ?? [],
  });
  const missing = required.filter((scope) => !granted.includes(scope));
  const outcome =
    missing.length === 0
      ? "allowed"
      : Option.isNone(principal)
        ? "unauthenticated"
        : "insufficient_scope";
  return {
    tool,
    principal: Option.getOrUndefined(Option.map(principal, (p) => p.id)),
    requiredScopes: [...required],
    grantedScopes: [...granted],
    missingScopes: missing,
    outcome,
  };
};

/**
 * One structured log line per guarded call: `debug` when allowed, `warning`
 * when denied. Annotations carry the verdict fields; annotations already on
 * the fiber (e.g. `correlationId`/`actor` set by `Correlation.within` through
 * the app's `within` hook) are inherited. Never the token.
 */
export const recordVerdict = (verdict: ScopeVerdict): Effect.Effect<void> =>
  (verdict.outcome === "allowed" ? Effect.logDebug : Effect.logWarning)("mcp: scope verdict").pipe(
    Effect.annotateLogs({
      tool: verdict.tool,
      principal: verdict.principal ?? "none",
      requiredScopes: verdict.requiredScopes,
      grantedScopes: verdict.grantedScopes,
      missingScopes: verdict.missingScopes,
      outcome: verdict.outcome,
    }),
  );

// --- errors ---------------------------------------------------------------------

/**
 * A denied {@link ScopeVerdict}: the principal lacks a required scope, or no
 * principal is attached at all. The HTTP guard renders it as `403` +
 * `insufficient_scope`; on other transports it becomes a message-only tool error.
 */
export class InsufficientScope extends Data.TaggedError("InsufficientScope")<{
  readonly verdict: ScopeVerdict;
}> {
  readonly classification: "transient" | "permanent" | "conflict" = "permanent";
  get tool(): string {
    return this.verdict.tool;
  }
  /** Scopes required but not granted. */
  get missing(): ReadonlyArray<string> {
    return this.verdict.missingScopes;
  }
  override get message(): string {
    const scopes = this.missing.map((scope) => `"${scope}"`).join(", ");
    return this.verdict.outcome === "unauthenticated"
      ? `unauthenticated: tool "${this.tool}" requires scope(s) ${scopes} and no principal is attached`
      : `insufficient_scope: tool "${this.tool}" requires scope(s) ${scopes}`;
  }
}

// --- tool scope registry (internal) ---------------------------------------------

/**
 * Required scopes per tool, resolved at dispatch: what the tool declared, else
 * the guard's `defaultScopes`, else nothing. Filled by tool registration and
 * the HTTP guard, read by both checks so they compute the same verdict.
 * Memoized like `McpServer.layer`: every reference to `ToolScopes.layer` in
 * one build shares the instance.
 */
export class ToolScopes extends Context.Tag("@structure-ai/mcp/ToolScopes")<
  ToolScopes,
  {
    readonly register: (
      tool: string,
      declared: ReadonlyArray<string> | undefined,
    ) => Effect.Effect<void>;
    readonly setDefault: (scopes: ReadonlyArray<string> | undefined) => Effect.Effect<void>;
    readonly requiredFor: (tool: string) => ReadonlyArray<string>;
  }
>() {
  static readonly layer: Layer.Layer<ToolScopes> = Layer.sync(ToolScopes, () => {
    const declared = new Map<string, ReadonlyArray<string>>();
    let defaults: ReadonlyArray<string> = [];
    return {
      register: (tool, scopes) =>
        Effect.sync(() => {
          if (scopes === undefined) declared.delete(tool);
          else declared.set(tool, scopes);
        }),
      setDefault: (scopes) =>
        Effect.sync(() => {
          defaults = scopes ?? [];
        }),
      requiredFor: (tool) => declared.get(tool) ?? defaults,
    };
  });
}

// --- protected resource metadata (RFC 9728) --------------------------------------

/** What the server publishes about itself as an OAuth 2.1 protected resource. */
export interface ProtectedResourceMetadataOptions {
  /**
   * The resource identifier: the absolute URL agents reach the MCP endpoint
   * at (e.g. `"https://api.example.com/mcp"`). Its origin and path derive the
   * `.well-known` locations and the `WWW-Authenticate` challenge; never taken
   * from the `Host` header.
   */
  readonly resource: string;
  /** Issuer URLs of the authorization servers that mint tokens for this resource. */
  readonly authorizationServers: ReadonlyArray<string>;
  readonly scopesSupported?: ReadonlyArray<string> | undefined;
  readonly resourceName?: string | undefined;
  readonly resourceDocumentation?: string | undefined;
}

/** RFC 9728 §2 document shape (the subset this package publishes). */
export const ProtectedResourceMetadata = Schema.Struct({
  resource: Schema.String,
  authorization_servers: Schema.Array(Schema.String),
  scopes_supported: Schema.optionalWith(Schema.Array(Schema.String), { exact: true }),
  bearer_methods_supported: Schema.optionalWith(
    Schema.Array(Schema.Literal("header", "body", "query")),
    { exact: true },
  ),
  resource_name: Schema.optionalWith(Schema.String, { exact: true }),
  resource_documentation: Schema.optionalWith(Schema.String, { exact: true }),
});
export type ProtectedResourceMetadata = typeof ProtectedResourceMetadata.Type;

const WELL_KNOWN = "/.well-known/oauth-protected-resource";

/** Origin and normalized path (no trailing slash, `""` for root) of the resource. */
const resourceParts = (
  options: ProtectedResourceMetadataOptions,
): { readonly origin: string; readonly path: string } => {
  const url = new URL(options.resource);
  return { origin: url.origin, path: url.pathname.replace(/\/+$/, "") };
};

/**
 * Well-known paths for the resource: the root document always, plus the
 * path-suffixed one (RFC 9728 §3.1) when the resource is not the origin root.
 */
export const wellKnownPaths = (
  options: ProtectedResourceMetadataOptions,
): ReadonlyArray<`/${string}`> => {
  const { path } = resourceParts(options);
  return path === "" ? [WELL_KNOWN] : [WELL_KNOWN, `${WELL_KNOWN}${path}`];
};

/** The metadata URL advertised in `WWW-Authenticate` (path-suffixed for non-root resources). */
export const resourceMetadataUrl = (options: ProtectedResourceMetadataOptions): string => {
  const { origin, path } = resourceParts(options);
  return `${origin}${WELL_KNOWN}${path}`;
};

/** Builds the RFC 9728 document from the options. */
export const protectedResourceMetadata = (
  options: ProtectedResourceMetadataOptions,
): ProtectedResourceMetadata => ({
  resource: options.resource,
  authorization_servers: [...options.authorizationServers],
  ...(options.scopesSupported !== undefined && { scopes_supported: [...options.scopesSupported] }),
  bearer_methods_supported: ["header"],
  ...(options.resourceName !== undefined && { resource_name: options.resourceName }),
  ...(options.resourceDocumentation !== undefined && {
    resource_documentation: options.resourceDocumentation,
  }),
});

/** Validates the options at composition time; a misconfigured resource is a wiring bug. */
export const validateResourceMetadata = (
  options: ProtectedResourceMetadataOptions,
): Effect.Effect<void> =>
  Effect.suspend(() => {
    let url: URL;
    try {
      url = new URL(options.resource);
    } catch {
      return Effect.dieMessage(
        `mcp auth: resourceMetadata.resource must be an absolute URL, got "${options.resource}"`,
      );
    }
    if (url.search !== "" || url.hash !== "") {
      return Effect.dieMessage(
        "mcp auth: resourceMetadata.resource must not carry a query or fragment (RFC 9728 §2)",
      );
    }
    if (options.authorizationServers.length === 0) {
      return Effect.dieMessage("mcp auth: resourceMetadata.authorizationServers must not be empty");
    }
    return Effect.void;
  });

// --- guard ----------------------------------------------------------------------

/**
 * Resource-server side of the MCP authorization flow. `verify` turns the
 * bearer token into the acting principal; any failure answers `401
 * invalid_token` and is never echoed to the client. `within` lets the
 * application propagate the principal to its own authorization (pass
 * `Principal.within` from `@structure-ai/authorization`): it wraps the whole
 * request, so tool and resource handlers run inside it.
 */
export interface McpAuthOptions<E = unknown, R = never> {
  readonly verify: (
    token: Redacted.Redacted<string>,
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<McpPrincipal, E, R>;
  readonly resourceMetadata: ProtectedResourceMetadataOptions;
  /**
   * Scopes required by every tool that declares none. Set it whenever tokens
   * may carry fewer scopes than the server exposes: without it, a tool with
   * no `scopes` is guarded by the bearer check only. A tool opts out
   * explicitly with `scopes: []`.
   */
  readonly defaultScopes?: ReadonlyArray<string> | undefined;
  readonly within?:
    | ((
        principal: McpPrincipal,
      ) => <A, E2, R2>(effect: Effect.Effect<A, E2, R2>) => Effect.Effect<A, E2, R2>)
    | undefined;
}

/** The token of an `Authorization: Bearer <token>` header, if well-formed. */
const bearerToken = (request: HttpServerRequest.HttpServerRequest): string | undefined => {
  const header = request.headers.authorization;
  if (header === undefined) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
};

const quote = (value: string): string => `"${value.replace(/["\\]/g, "\\$&")}"`;

const challengeHeader = (params: Readonly<Record<string, string>>): string =>
  `Bearer ${Object.entries(params)
    .map(([key, value]) => `${key}=${quote(value)}`)
    .join(", ")}`;

/**
 * An RFC 6750 error response. The body mirrors the challenge parameters so
 * non-browser clients can read the error without parsing the header.
 */
const reject = (
  status: 401 | 403,
  body: Readonly<Record<string, string>>,
  challenge: Readonly<Record<string, string>>,
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.unsafeJson(body, {
    status,
    headers: { "www-authenticate": challengeHeader(challenge) },
  });

/** Names of tools a JSON-RPC body (single or batched) asks to call. */
const requestedTools = (body: unknown): ReadonlyArray<string> => {
  const messages: ReadonlyArray<unknown> = Array.isArray(body) ? body : [body];
  const names: Array<string> = [];
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const { method, params } = message as { readonly method?: unknown; readonly params?: unknown };
    if (method !== "tools/call" || typeof params !== "object" || params === null) continue;
    const name = (params as { readonly name?: unknown }).name;
    if (typeof name === "string") names.push(name);
  }
  return names;
};

/**
 * Wraps the MCP transport app: rejects missing/invalid bearers with `401` +
 * the RFC 9728 challenge, `tools/call` on a tool whose required scopes
 * (declared, else `defaultScopes`) the principal lacks with `403
 * insufficient_scope`, and runs everything else on behalf of the principal.
 * The verifier's services are captured once (`context`).
 */
export const guard =
  <E, R>(
    options: McpAuthOptions<E, R>,
    scopes: Context.Tag.Service<ToolScopes>,
    context: Context.Context<R>,
  ) =>
  (app: HttpApp.Default<never, Scope.Scope>): HttpApp.Default<never, Scope.Scope> => {
    const metadata = resourceMetadataUrl(options.resourceMetadata);
    const apply = options.within;
    return Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const token = bearerToken(request);
      if (token === undefined) {
        return reject(
          401,
          { error: "unauthorized", error_description: "A bearer access token is required" },
          { resource_metadata: metadata },
        );
      }
      const verified = yield* options
        .verify(Redacted.make(token), request)
        .pipe(Effect.provide(context), Effect.either);
      if (Either.isLeft(verified)) {
        yield* Effect.logDebug("mcp: bearer token rejected").pipe(
          Effect.annotateLogs("cause", describeFailure(verified.left)),
        );
        const description = "The access token is invalid or expired";
        return reject(
          401,
          { error: "invalid_token", error_description: description },
          { error: "invalid_token", error_description: description, resource_metadata: metadata },
        );
      }
      const principal = verified.right;
      // The body is cached by the platform request, so the transport reads it again.
      const body = yield* request.json.pipe(Effect.orElseSucceed(() => undefined));
      // Verdicts are computed and recorded on behalf of the principal so the
      // log line inherits whatever the `within` hook annotates (actor, correlation).
      const guarded = Effect.gen(function* () {
        for (const tool of requestedTools(body)) {
          const verdict = scopeVerdict(tool, scopes.requiredFor(tool), Option.some(principal));
          if (verdict.outcome === "allowed") continue;
          yield* recordVerdict(verdict);
          const denied = new InsufficientScope({ verdict });
          const scope = verdict.missingScopes.join(" ");
          return reject(
            403,
            { error: "insufficient_scope", error_description: denied.message, scope },
            {
              error: "insufficient_scope",
              error_description: denied.message,
              scope,
              resource_metadata: metadata,
            },
          );
        }
        return yield* app;
      });
      const run = within(principal)(guarded);
      return yield* apply === undefined ? run : apply(principal)(run);
    });
  };

/** Safe, log-only description of a verifier failure (tag or constructor name). */
const describeFailure = (failure: unknown): string => {
  if (typeof failure === "object" && failure !== null) {
    const tag = (failure as { readonly _tag?: unknown })._tag;
    if (typeof tag === "string") return tag;
    return failure.constructor.name;
  }
  return typeof failure;
};

/** `GET` handler serving the RFC 9728 document. */
export const metadataHandler = (
  options: ProtectedResourceMetadataOptions,
): HttpApp.Default<never, never> =>
  Effect.succeed(
    HttpServerResponse.unsafeJson(protectedResourceMetadata(options), {
      headers: { "cache-control": "public, max-age=300" },
    }),
  );
