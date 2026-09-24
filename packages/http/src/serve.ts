import type * as Etag from "@effect/platform/Etag";
import * as HttpApi from "@effect/platform/HttpApi";
import * as HttpApiBuilder from "@effect/platform/HttpApiBuilder";
import type * as HttpApiGroup from "@effect/platform/HttpApiGroup";
import * as HttpApp from "@effect/platform/HttpApp";
import type * as HttpPlatform from "@effect/platform/HttpPlatform";
import * as HttpServer from "@effect/platform/HttpServer";
import * as HttpServerError from "@effect/platform/HttpServerError";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import type * as BunContext from "@effect/platform-bun/BunContext";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import { Correlation } from "@structure-ai/observability";
import { Readiness } from "@structure-ai/runtime";
import { Cause, Data, type Duration, Effect, Layer, Option } from "effect";
import { defaultErrorResponse } from "./errors.js";
import * as Middleware from "./middleware.js";
import { compileMounts, InvalidMounts, type Mount, type MountTable, matchMount } from "./mounts.js";
import {
  InvalidStaticOptions,
  makeStatic,
  type StaticOptions,
  type StaticServer,
} from "./static.js";

/** The mounted api a boundary replacement may need (route templates, docs). */
export type MountedApi = HttpApi.HttpApi<string, HttpApiGroup.HttpApiGroup.AnyWithProps>;

/** Options for {@link serve} governing the middleware stack. */
export interface MiddlewareStackOptions {
  /**
   * Configure the standard stack's correlation policy and response headers
   * without replacing it. Cannot be combined with `boundary` (a replacement
   * owns its own correlation).
   */
  readonly correlation?: Middleware.CorrelationOptions;
  /**
   * Replace the standard boundary middleware (correlation, logging, metrics,
   * problem mapping) with your own. The replacement receives the app with
   * mounts and static dispatch already composed and the mounted api, and must
   * answer every failure it receives (unmatched routes fail
   * `RouteNotFound`); everything it produces is served by the same graceful
   * Bun composition — you replace the boundary, not the server.
   */
  readonly boundary?: (
    app: HttpApp.Default,
    api: MountedApi,
  ) => HttpApp.Default<never, HttpServerRequest.HttpServerRequest>;
}

/** Middleware stack options that cannot be served. */
export class InvalidMiddlewareOptions extends Data.TaggedError("InvalidMiddlewareOptions")<{
  readonly violations: ReadonlyArray<string>;
}> {
  readonly classification: "permanent" = "permanent";
  override get message(): string {
    return `invalid middleware options: ${this.violations.join("; ")}`;
  }
}

const middlewareViolations = (
  options: MiddlewareStackOptions | undefined,
): ReadonlyArray<string> => {
  if (options === undefined) return [];
  const violations = [...Middleware.correlationViolations(options.correlation)];
  if (options.correlation !== undefined && options.boundary !== undefined) {
    violations.push(
      "middleware.correlation configures the standard stack but middleware.boundary replaces it — choose one",
    );
  }
  return violations;
};

/** Options for {@link serve}. */
export interface ServeOptions {
  readonly port: number;
  /** Hostname to bind. Default: Bun's default (`0.0.0.0`). */
  readonly host?: string;
  /**
   * How long to keep serving after the process is asked to stop, once
   * readiness has been flipped to unready — gives load balancers time to
   * drain. Default: 0 (flip unready, then let Bun finish in-flight requests).
   */
  readonly gracePeriod?: Duration.DurationInput;
  /**
   * Raw web handlers served beside the `HttpApi` on the same listener,
   * evaluated before the router: the longest matching prefix wins (segment
   * boundaries only). They share the middleware boundary (correlation
   * headers, request log line, metrics, defect → 500 problem), the readiness
   * flip and the grace period with the api routes. Invalid or duplicate
   * prefixes fail the layer with {@link InvalidMounts}.
   */
  readonly mounts?: ReadonlyArray<Mount>;
  /**
   * Static assets (an embedded SPA build) served after the router: a
   * `GET`/`HEAD` the api does not route is answered from `directory` when a
   * file exists, from `spaFallback` when the request accepts `text/html`,
   * and by the api's 404 problem otherwise. Invalid options fail the layer
   * with {@link InvalidStaticOptions}.
   */
  readonly static?: StaticOptions;
  /**
   * The middleware stack. Default: the standard stack (correlation, boundary
   * logging, metrics, problem mapping). Pass `correlation` to configure its
   * id policy and response headers, or `boundary` to replace the whole stack
   * while keeping the same graceful server composition — see
   * {@link MiddlewareStackOptions}. Invalid combinations fail the layer with
   * {@link InvalidMiddlewareOptions}.
   */
  readonly middleware?: MiddlewareStackOptions;
}

/** {@link ServeOptions} minus the listener details, for {@link serveTestWith}. */
export type ServeTestOptions = Omit<ServeOptions, "port" | "host">;

/**
 * Flips `Readiness` to unready as the very first step of shutdown, then waits
 * the grace period before the server (built underneath) is torn down.
 */
const graceful = (
  gracePeriod: Duration.DurationInput | undefined,
): Layer.Layer<never, never, Readiness> =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const readiness = yield* Readiness;
      yield* Effect.addFinalizer(() =>
        readiness.setUnready.pipe(Effect.andThen(Effect.sleep(gracePeriod ?? 0))),
      );
    }),
  );

const pathOf = (request: HttpServerRequest.HttpServerRequest): string => {
  const url = request.url;
  const end = url.indexOf("?");
  return end === -1 ? url : url.slice(0, end);
};

/**
 * Precedence, innermost wrapper around the router so the standard stack
 * still applies to everything it produces:
 *
 * 1. mounts — longest prefix wins, before the router;
 * 2. HttpApi routes;
 * 3. static assets — only when the router reported `RouteNotFound`;
 * 4. the 404 problem (the router's failure re-raised for `problems`).
 */
const dispatch =
  (mounts: MountTable, staticServer: StaticServer | undefined) =>
  (app: HttpApp.Default): HttpApp.Default<never, HttpServerRequest.HttpServerRequest> =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const path = pathOf(request);
      const mount = matchMount(mounts, path);
      if (mount !== undefined) {
        // Promise rejections are expected transport failures at this boundary.
        // Log them and respond safely without manufacturing a defect.
        return yield* HttpApp.fromWebHandler(mount.handler).pipe(
          Effect.catchAll((error) =>
            Effect.logError("mounted handler failed", error).pipe(
              Effect.zipRight(
                Effect.map(Correlation.current, (context) =>
                  defaultErrorResponse(undefined, context.correlationId),
                ),
              ),
            ),
          ),
        );
      }
      if (staticServer === undefined) return yield* app;
      // HttpApi's composed app erases RouteNotFound from its declared channel.
      // Recover only a single validated routing failure, never a compound cause.
      return yield* app.pipe(
        Effect.catchAllCause((cause) => {
          const failure: Cause.Cause<unknown> = cause;
          if (
            !Cause.isFailType(failure) ||
            !(failure.error instanceof HttpServerError.RouteNotFound)
          ) {
            return Effect.failCause(cause);
          }
          return staticServer.serve(request, path).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.failCause(cause),
                onSome: Effect.succeed,
              }),
            ),
          );
        }),
      );
    });

// Validated mount prefixes always start with "/"; this narrows them to the
// template type `routeLabel` accepts.
const isTemplate = (value: string): value is `/${string}` => value.startsWith("/");

/**
 * The single `HttpApi`-level middleware registered by `serve`: mounts and
 * static dispatch wrapped in the standard stack. Registered as one layer so
 * the order is fixed regardless of layer build order.
 */
const composed = (options: ServeTestOptions): Layer.Layer<never, never, HttpApi.Api> => {
  const { table, violations: mountViolations } = compileMounts(options.mounts ?? []);
  if (mountViolations.length > 0) {
    return Layer.die(new InvalidMounts({ violations: mountViolations }));
  }
  const stackViolations = middlewareViolations(options.middleware);
  if (stackViolations.length > 0) {
    return Layer.die(new InvalidMiddlewareOptions({ violations: stackViolations }));
  }
  const compiled = options.static === undefined ? undefined : makeStatic(options.static);
  if (compiled !== undefined && compiled.violations.length > 0) {
    return Layer.die(new InvalidStaticOptions({ violations: compiled.violations }));
  }
  const withDispatch = dispatch(table, compiled?.server);
  // Mounts are labelled by their prefix (`/auth/*`), never by the path the
  // handler received; api routes resolve to their endpoint template.
  const mountTemplates = (options.mounts ?? []).flatMap((mount) =>
    mount.prefix === "/" ? [] : [mount.prefix, `${mount.prefix}/*`].filter(isTemplate),
  );
  return HttpApiBuilder.middleware(
    Effect.map(HttpApi.Api, ({ api }) => (app: HttpApp.Default) => {
      const dispatched = withDispatch(app);
      return options.middleware?.boundary === undefined
        ? Middleware.standard(dispatched, {
            routeLabel: Middleware.routeLabel(api, { extra: mountTemplates }),
            ...(options.middleware?.correlation !== undefined && {
              correlation: options.middleware.correlation,
            }),
          })
        : options.middleware.boundary(dispatched, api);
    }),
  );
};

/**
 * One launchable layer for a production HTTP api: `HttpApiBuilder.serve` with
 * the standard middleware stack (correlation, boundary logging, metrics,
 * problem mapping), optional raw mounts and static assets on the same
 * listener, a Bun HTTP server, and graceful shutdown (readiness goes unready
 * before the listener stops accepting).
 *
 * Provide the api implementation (`HttpApiBuilder.api(api)` + group layers),
 * optionally `Docs.layer()`, and `Readiness.layer` (usually via
 * `@structure-ai/runtime`), then `Layer.launch` the result:
 *
 * ```ts
 * serve({
 *   port: 3000,
 *   mounts: [{ prefix: "/auth", handler: auth.handler }],
 *   static: { directory: "./dist", spaFallback: "index.html" },
 * }).pipe(
 *   Layer.provide(Docs.layer()),
 *   Layer.provide(MyApiLive),
 *   Layer.provide(Readiness.layer),
 *   Layer.launch,
 *   BunRuntime.runMain,
 * )
 * ```
 */
export const serve = (options: ServeOptions): Layer.Layer<never, never, HttpApi.Api | Readiness> =>
  graceful(options.gracePeriod).pipe(
    Layer.provide(
      HttpApiBuilder.serve().pipe(
        HttpServer.withLogAddress,
        Layer.provide(composed(options)),
        Layer.provide(
          BunHttpServer.layer({
            port: options.port,
            ...(options.host !== undefined && { hostname: options.host }),
          }),
        ),
      ),
    ),
  );

/**
 * The same stack as {@link serve} on a random free port, with the
 * `HttpServer` exposed so tests can read the actual address — no config, no
 * fixed ports, real sockets:
 *
 * ```ts
 * const TestLive = serveTest.pipe(
 *   Layer.provide(MyApiLive),
 *   Layer.provideMerge(Readiness.layer),
 * );
 * // ... build in a scope, read HttpServer.address for the port.
 * ```
 *
 * Use {@link serveTestWith} to test mounts, static assets or the grace period.
 */
export const serveTest: Layer.Layer<
  HttpServer.HttpServer | HttpPlatform.HttpPlatform | Etag.Generator | BunContext.BunContext,
  never,
  HttpApi.Api
> = HttpApiBuilder.serve().pipe(
  Layer.provide(Middleware.layer),
  Layer.provideMerge(BunHttpServer.layer({ port: 0 })),
);

/**
 * {@link serveTest} with the composition options of {@link serve} (`mounts`,
 * `static`, `gracePeriod`), so the whole surface an app serves on one port
 * is testable without a fixed port. Requires `Readiness` like `serve` does.
 */
export const serveTestWith = (
  options: ServeTestOptions,
): Layer.Layer<
  HttpServer.HttpServer | HttpPlatform.HttpPlatform | Etag.Generator | BunContext.BunContext,
  never,
  HttpApi.Api | Readiness
> =>
  graceful(options.gracePeriod).pipe(
    Layer.provideMerge(
      HttpApiBuilder.serve().pipe(
        Layer.provide(composed(options)),
        Layer.provideMerge(BunHttpServer.layer({ port: 0 })),
      ),
    ),
  );
