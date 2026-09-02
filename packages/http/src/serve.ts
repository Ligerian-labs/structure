import type * as Etag from "@effect/platform/Etag";
import * as HttpApi from "@effect/platform/HttpApi";
import * as HttpApiBuilder from "@effect/platform/HttpApiBuilder";
import * as HttpApp from "@effect/platform/HttpApp";
import type * as HttpPlatform from "@effect/platform/HttpPlatform";
import * as HttpServer from "@effect/platform/HttpServer";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import type * as BunContext from "@effect/platform-bun/BunContext";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import { Readiness } from "@structure-ai/runtime";
import { Cause, type Duration, Effect, Layer, Option } from "effect";
import * as Middleware from "./middleware.js";
import { compileMounts, InvalidMounts, type Mount, type MountTable, matchMount } from "./mounts.js";
import {
  InvalidStaticOptions,
  makeStatic,
  type StaticOptions,
  type StaticServer,
} from "./static.js";

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

const isRouteNotFound = (cause: Cause.Cause<unknown>): boolean =>
  Option.match(Cause.failureOption(cause), {
    onNone: () => false,
    onSome: (error) =>
      typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      (error as { _tag: unknown })._tag === "RouteNotFound",
  });

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
        // A rejecting handler is a defect: `problems` logs the cause and
        // answers with the 500 problem carrying only the correlation id.
        return yield* HttpApp.fromWebHandler(mount.handler).pipe(
          Effect.catchAll((error) => Effect.die(error)),
        );
      }
      if (staticServer === undefined) return yield* app;
      return yield* app.pipe(
        Effect.catchAllCause((cause) =>
          isRouteNotFound(cause)
            ? staticServer.serve(request, path).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.failCause(cause),
                    onSome: Effect.succeed,
                  }),
                ),
              )
            : Effect.failCause(cause),
        ),
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
    Effect.map(
      HttpApi.Api,
      ({ api }) =>
        (app: HttpApp.Default) =>
          Middleware.standard(withDispatch(app), {
            routeLabel: Middleware.routeLabel(api, { extra: mountTemplates }),
          }),
    ),
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
