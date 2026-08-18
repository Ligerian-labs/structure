import type * as Etag from "@effect/platform/Etag";
import type * as HttpApi from "@effect/platform/HttpApi";
import * as HttpApiBuilder from "@effect/platform/HttpApiBuilder";
import type * as HttpPlatform from "@effect/platform/HttpPlatform";
import * as HttpServer from "@effect/platform/HttpServer";
import type * as BunContext from "@effect/platform-bun/BunContext";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import { Readiness } from "@structure-ai/runtime";
import { type Duration, Effect, Layer } from "effect";
import * as Middleware from "./middleware.js";

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
}

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

/**
 * One launchable layer for a production HTTP api: `HttpApiBuilder.serve` with
 * the standard middleware stack (correlation, boundary logging, metrics,
 * problem mapping), a Bun HTTP server, and graceful shutdown (readiness goes
 * unready before the listener stops accepting).
 *
 * Provide the api implementation (`HttpApiBuilder.api(api)` + group layers),
 * optionally `Docs.layer()`, and `Readiness.layer` (usually via
 * `@structure-ai/runtime`), then `Layer.launch` the result:
 *
 * ```ts
 * serve({ port: 3000 }).pipe(
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
        Layer.provide(Middleware.layer),
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
 */
export const serveTest: Layer.Layer<
  HttpServer.HttpServer | HttpPlatform.HttpPlatform | Etag.Generator | BunContext.BunContext,
  never,
  HttpApi.Api
> = HttpApiBuilder.serve().pipe(
  Layer.provide(Middleware.layer),
  Layer.provideMerge(BunHttpServer.layer({ port: 0 })),
);
