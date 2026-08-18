import type * as HttpApi from "@effect/platform/HttpApi";
import * as HttpApiBuilder from "@effect/platform/HttpApiBuilder";
import * as HttpApiEndpoint from "@effect/platform/HttpApiEndpoint";
import type { HttpApiDecodeError } from "@effect/platform/HttpApiError";
import * as HttpApiGroup from "@effect/platform/HttpApiGroup";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import * as OpenApi from "@effect/platform/OpenApi";
import { Readiness } from "@structure-ai/runtime";
import { Effect, type Layer, Schema } from "effect";

/** Body of `GET /health/live`. */
export const LiveResponse = Schema.Struct({ status: Schema.Literal("live") });

/**
 * Body of `GET /health/ready`: the aggregate flag plus the per-check report.
 * Check names are operator-chosen labels; no secrets or topology belong here.
 */
export const ReadyResponse = Schema.Struct({
  ready: Schema.Boolean,
  checks: Schema.Array(Schema.Struct({ name: Schema.String, ok: Schema.Boolean })),
});

/**
 * Ready-made health probe group: mount it on any api with `.add(Health.group)`
 * and implement it with `Health.layer(api)`.
 *
 * - `GET /health/live`  → 200 whenever the process can respond at all.
 * - `GET /health/ready` → 200 when `Readiness.checkAll` reports ready,
 *   otherwise 503 — both carry `{ ready, checks: [{ name, ok }] }`.
 */
export const group = HttpApiGroup.make("health")
  .add(HttpApiEndpoint.get("live", "/health/live").addSuccess(LiveResponse))
  .add(HttpApiEndpoint.get("ready", "/health/ready").addSuccess(ReadyResponse))
  .annotate(OpenApi.Description, "Liveness and readiness probes");

/** The type of the health group, for api compositions that want to name it. */
export type Group = typeof group;

/**
 * Implements the health endpoints for an api that includes {@link group}.
 * Requires `@structure-ai/runtime` `Readiness`.
 *
 * ```ts
 * const api = Api.make("my-api").add(users).add(Health.group);
 * const HealthLive = Health.layer(api);
 * ```
 */
export const layer = <ApiId extends string, Groups extends HttpApiGroup.HttpApiGroup.Any, E, R>(
  api: HttpApi.HttpApi<ApiId, Groups, E, R> &
    ([Group] extends [Groups] ? unknown : "api must include Health.group"),
): Layer.Layer<HttpApiGroup.ApiGroup<ApiId, "health">, never, Readiness> =>
  // The generic group builder cannot see through an abstract `Groups` union,
  // so the api is pinned to the health group it is known to contain. Runtime
  // behavior only depends on `api.groups["health"]`, which the parameter type
  // guarantees is present.
  HttpApiBuilder.group(
    api as unknown as HttpApi.HttpApi<ApiId, Group, HttpApiDecodeError>,
    "health",
    (handlers) =>
      handlers
        .handle("live", () => Effect.succeed({ status: "live" as const }))
        .handle("ready", () =>
          Effect.gen(function* () {
            const readiness = yield* Readiness;
            const report = yield* readiness.checkAll;
            return report.ready ? report : HttpServerResponse.unsafeJson(report, { status: 503 });
          }),
        ),
  ) as Layer.Layer<HttpApiGroup.ApiGroup<ApiId, "health">, never, Readiness>;
