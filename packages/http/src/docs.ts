import type * as HttpApi from "@effect/platform/HttpApi";
import * as HttpApiBuilder from "@effect/platform/HttpApiBuilder";
import * as HttpApiSwagger from "@effect/platform/HttpApiSwagger";
import { Layer } from "effect";

/** Options for {@link layer}. */
export interface DocsOptions {
  /** Where the Swagger UI is served. Default: `/docs`. */
  readonly path?: `/${string}`;
  /** Where the raw OpenAPI JSON is served. Default: `/openapi.json`. */
  readonly openApiPath?: `/${string}`;
}

/**
 * Serves interactive Swagger UI (default `/docs`) plus the raw OpenAPI
 * specification (default `/openapi.json`) for the mounted api. Provide it to
 * `serve`/`serveTest` next to the api layer:
 *
 * ```ts
 * serve({ port: 3000 }).pipe(
 *   Layer.provide(Docs.layer()),
 *   Layer.provide(MyApiLive),
 * )
 * ```
 */
export const layer = (options?: DocsOptions): Layer.Layer<never, never, HttpApi.Api> =>
  Layer.mergeAll(
    HttpApiSwagger.layer({ path: options?.path ?? "/docs" }),
    HttpApiBuilder.middlewareOpenApi({ path: options?.openApiPath ?? "/openapi.json" }),
  );
