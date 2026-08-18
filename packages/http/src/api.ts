import type * as HttpApi from "@effect/platform/HttpApi";
import type * as HttpApiEndpoint from "@effect/platform/HttpApiEndpoint";
import type * as HttpApiGroup from "@effect/platform/HttpApiGroup";
import * as OpenApi from "@effect/platform/OpenApi";

/**
 * Define an API. Thin, stable alias over `@effect/platform` `HttpApi`.
 *
 * ```ts
 * import { Api, ApiGroup, ApiEndpoint, annotate } from "@structure/http";
 * import { Schema } from "effect";
 *
 * const users = ApiGroup.make("users").add(
 *   ApiEndpoint.get("getUser")`/users/${ApiSchema.param("id", Schema.String)}`
 *     .addSuccess(Schema.Struct({ id: Schema.String, name: Schema.String })),
 * ).add(
 *   ApiEndpoint.post("createUser", "/users")
 *     .setPayload(Schema.Struct({ name: Schema.String }))
 *     .addSuccess(Schema.Struct({ id: Schema.String })),
 * );
 *
 * const api = Api.make("my-api").add(users).pipe(
 *   annotate({ title: "My API", version: "1.0.0" }),
 * );
 * ```
 */
export * as Api from "@effect/platform/HttpApi";
/**
 * Define endpoints (`ApiEndpoint.get/post/put/patch/del/head/options`), with
 * schema-typed path params (template literal + `ApiSchema.param`), payload
 * (`setPayload`), url params (`setUrlParams`) and success/error responses.
 */
export * as ApiEndpoint from "@effect/platform/HttpApiEndpoint";
/** Ready-made HTTP error schemas from the platform (401, 404, ... variants). */
export * as ApiError from "@effect/platform/HttpApiError";
/** Define a group of endpoints. Alias of `HttpApiGroup`. */
export * as ApiGroup from "@effect/platform/HttpApiGroup";
/**
 * Schema helpers for HTTP APIs: `param` for typed path segments, `annotations`
 * for statuses, `Multipart`, empty responses (`Created`, `NoContent`), etc.
 */
export * as ApiSchema from "@effect/platform/HttpApiSchema";
/** OpenAPI annotation tags (`Title`, `Version`, `Description`, ...) and `fromApi`. */
export * as OpenApiAnnotations from "@effect/platform/OpenApi";

/** Documentation metadata for an API, applied as OpenAPI annotations. */
export interface ApiInfo {
  readonly title?: string;
  readonly version?: string;
  readonly description?: string;
  readonly summary?: string;
}

/**
 * Annotates an API with OpenAPI info metadata:
 *
 * ```ts
 * const api = Api.make("billing").add(group).pipe(
 *   annotate({ title: "Billing", version: "2.1.0", description: "Money things" }),
 * );
 * ```
 */
export const annotate =
  (info: ApiInfo) =>
  <Id extends string, Groups extends HttpApiGroup.HttpApiGroup.Any, E, R>(
    self: HttpApi.HttpApi<Id, Groups, E, R>,
  ): HttpApi.HttpApi<Id, Groups, E, R> => {
    let api = self;
    if (info.title !== undefined) api = api.annotate(OpenApi.Title, info.title);
    if (info.version !== undefined) api = api.annotate(OpenApi.Version, info.version);
    if (info.description !== undefined) api = api.annotate(OpenApi.Description, info.description);
    if (info.summary !== undefined) api = api.annotate(OpenApi.Summary, info.summary);
    return api;
  };

/**
 * Annotates a group with OpenAPI metadata (title/description/summary).
 */
export const annotateGroup =
  (info: Omit<ApiInfo, "version">) =>
  <
    Id extends string,
    Endpoints extends HttpApiEndpoint.HttpApiEndpoint.Any,
    E,
    R,
    TopLevel extends boolean,
  >(
    self: HttpApiGroup.HttpApiGroup<Id, Endpoints, E, R, TopLevel>,
  ): HttpApiGroup.HttpApiGroup<Id, Endpoints, E, R, TopLevel> => {
    let group = self;
    if (info.title !== undefined) group = group.annotate(OpenApi.Title, info.title);
    if (info.description !== undefined)
      group = group.annotate(OpenApi.Description, info.description);
    if (info.summary !== undefined) group = group.annotate(OpenApi.Summary, info.summary);
    return group;
  };
