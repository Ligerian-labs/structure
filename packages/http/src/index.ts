/**
 * `@structure-ai/http` — thin, opinionated bindings over `@effect/platform`
 * `HttpApi`: schema-typed routes with full inference, OpenAPI docs, health
 * probes, request correlation, problem-details error mapping, a CQRS bridge
 * and a graceful Bun server.
 */

// The pieces of the platform apps need to implement and mount an api.
export * as HttpApiBuilder from "@effect/platform/HttpApiBuilder";
export * as HttpApiClient from "@effect/platform/HttpApiClient";
export * as HttpServer from "@effect/platform/HttpServer";
export * as HttpServerRequest from "@effect/platform/HttpServerRequest";
export * as HttpServerResponse from "@effect/platform/HttpServerResponse";
export {
  Api,
  ApiEndpoint,
  ApiError,
  ApiGroup,
  type ApiInfo,
  ApiSchema,
  annotate,
  annotateGroup,
  OpenApiAnnotations,
} from "./api.js";
export * as HttpCqrs from "./cqrs.js";
export * as Docs from "./docs.js";
export {
  BadRequestProblem,
  ConflictProblem,
  defaultErrorResponse,
  ForbiddenProblem,
  GatewayTimeoutProblem,
  type HttpProblem,
  HttpProblemSchema,
  InternalServerProblem,
  NotFoundProblem,
  problemResponse,
  problemStatus,
  toProblem,
  withDefaultErrors,
} from "./errors.js";
export * as Health from "./health.js";
export * as Middleware from "./middleware.js";
export { type ServeOptions, serve, serveTest } from "./serve.js";
