import type * as HttpApiEndpoint from "@effect/platform/HttpApiEndpoint";
import * as HttpApiSchema from "@effect/platform/HttpApiSchema";
import type { HttpMethod } from "@effect/platform/HttpMethod";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import { Schema } from "effect";

/**
 * Problem-details-ish HTTP error bodies: `{ error, message, correlationId?,
 * issues? }`. One class per status so `HttpApiBuilder` can pick the response
 * status from the schema annotation and OpenAPI documents each of them.
 *
 * Handlers fail with instances of these classes; anything else that escapes a
 * handler is turned into a 500 by the `problems` middleware without leaking
 * internals.
 */
const problemFields = {
  /** The stable, machine-readable error tag (e.g. `"ValidationFailed"`). */
  error: Schema.String,
  /** Human-readable, safe-to-expose description. */
  message: Schema.String,
  /** Correlation id of the failed request, when one was active. */
  correlationId: Schema.optional(Schema.String),
  /** Per-field validation issues, for 400 responses. */
  issues: Schema.optional(Schema.Array(Schema.String)),
} as const;

/** 400: the request shape never reached the domain. */
export class BadRequestProblem extends Schema.Class<BadRequestProblem>("BadRequestProblem")(
  problemFields,
  HttpApiSchema.annotations({ status: 400 }),
) {}

/** 401: no (or no valid) principal; authenticating may help. */
export class UnauthorizedProblem extends Schema.Class<UnauthorizedProblem>("UnauthorizedProblem")(
  problemFields,
  HttpApiSchema.annotations({ status: 401 }),
) {}

/** 403: the action was understood but is not allowed for this actor. */
export class ForbiddenProblem extends Schema.Class<ForbiddenProblem>("ForbiddenProblem")(
  problemFields,
  HttpApiSchema.annotations({ status: 403 }),
) {}

/** 404: the addressed entity (or route) does not exist. */
export class NotFoundProblem extends Schema.Class<NotFoundProblem>("NotFoundProblem")(
  problemFields,
  HttpApiSchema.annotations({ status: 404 }),
) {}

/** 409: optimistic concurrency conflict; the caller may reload and retry. */
export class ConflictProblem extends Schema.Class<ConflictProblem>("ConflictProblem")(
  problemFields,
  HttpApiSchema.annotations({ status: 409 }),
) {}

/** 504: the handler did not finish within its deadline. */
export class GatewayTimeoutProblem extends Schema.Class<GatewayTimeoutProblem>(
  "GatewayTimeoutProblem",
)(problemFields, HttpApiSchema.annotations({ status: 504 })) {}

/** 500: anything unexpected. Carries the correlation id and nothing else. */
export class InternalServerProblem extends Schema.Class<InternalServerProblem>(
  "InternalServerProblem",
)(problemFields, HttpApiSchema.annotations({ status: 500 })) {}

/** Union of every problem response this package produces. */
export type HttpProblem =
  | BadRequestProblem
  | UnauthorizedProblem
  | ForbiddenProblem
  | NotFoundProblem
  | ConflictProblem
  | GatewayTimeoutProblem
  | InternalServerProblem;

/** Schema union of all problems — usable with `addError` on api/group/endpoint. */
export const HttpProblemSchema = Schema.Union(
  BadRequestProblem,
  UnauthorizedProblem,
  ForbiddenProblem,
  NotFoundProblem,
  ConflictProblem,
  GatewayTimeoutProblem,
  InternalServerProblem,
);

/** HTTP status of a problem, read from its schema annotation. */
export const problemStatus = (problem: HttpProblem): number =>
  HttpApiSchema.getStatusError(
    problem instanceof BadRequestProblem
      ? BadRequestProblem
      : problem instanceof UnauthorizedProblem
        ? UnauthorizedProblem
        : problem instanceof ForbiddenProblem
          ? ForbiddenProblem
          : problem instanceof NotFoundProblem
            ? NotFoundProblem
            : problem instanceof ConflictProblem
              ? ConflictProblem
              : problem instanceof GatewayTimeoutProblem
                ? GatewayTimeoutProblem
                : InternalServerProblem,
  );

/**
 * Declares the standard problem responses on an endpoint so handlers may fail
 * with any {@link HttpProblem} (e.g. the ones produced by the CQRS bridge).
 */
export const withDefaultErrors = <
  Name extends string,
  Method extends HttpMethod,
  Path,
  UrlParams,
  Payload,
  Headers,
  Success,
  Error,
  R,
  RE,
>(
  endpoint: HttpApiEndpoint.HttpApiEndpoint<
    Name,
    Method,
    Path,
    UrlParams,
    Payload,
    Headers,
    Success,
    Error,
    R,
    RE
  >,
): HttpApiEndpoint.HttpApiEndpoint<
  Name,
  Method,
  Path,
  UrlParams,
  Payload,
  Headers,
  Success,
  Error | HttpProblem,
  R,
  RE
> => endpoint.addError(HttpProblemSchema);

const hasTag = (u: unknown): u is { readonly _tag: string } =>
  typeof u === "object" &&
  u !== null &&
  "_tag" in u &&
  typeof (u as { _tag: unknown })._tag === "string";

const stringField = (u: object, key: string): string | undefined => {
  const value = (u as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
};

const issuesField = (u: object): ReadonlyArray<string> => {
  const value = (u as Record<string, unknown>).issues;
  return Array.isArray(value)
    ? value.filter((issue): issue is string => typeof issue === "string")
    : [];
};

/** Formats platform `HttpApiDecodeError` issues (`{ path, message }`) as strings. */
const decodeIssues = (u: object): ReadonlyArray<string> => {
  const value = (u as Record<string, unknown>).issues;
  if (!Array.isArray(value)) return [];
  const out: Array<string> = [];
  for (const issue of value) {
    if (typeof issue !== "object" || issue === null) continue;
    const message = stringField(issue, "message");
    if (message === undefined) continue;
    const path = (issue as Record<string, unknown>).path;
    const prefix = Array.isArray(path) && path.length > 0 ? `${path.join(".")}: ` : "";
    out.push(`${prefix}${message}`);
  }
  return out;
};

const internal = (correlationId: string | undefined): InternalServerProblem =>
  new InternalServerProblem({
    error: "InternalServerError",
    message: "internal server error",
    ...(correlationId !== undefined && { correlationId }),
  });

/**
 * Maps the framework error taxonomy to HTTP problem responses without leaking
 * internals:
 *
 * - `ValidationFailed` → 400 with the issues list
 * - `Unauthenticated`  → 401 (no usable principal; `@structure-ai/authorization`)
 * - `Unauthorized`     → 403 (bus-level denial; `@structure-ai/cqrs`)
 * - `PermissionDenied` → 403 (policy denial; `@structure-ai/authorization`)
 * - `NotFound`         → 404 (entity + id)
 * - `ConcurrencyConflict` → 409
 * - `DispatchTimeout`  → 504
 * - `RouteNotFound`    → 404
 * - anything else (including defects) → 500 with the correlation id only
 *
 * Discrimination is structural (by `_tag`), so any error following the
 * `@structure-ai/domain` taxonomy maps correctly regardless of where it came from.
 */
export const toProblem = (error: unknown, correlationId?: string): HttpProblem => {
  if (error instanceof BadRequestProblem) return error;
  if (error instanceof UnauthorizedProblem) return error;
  if (error instanceof ForbiddenProblem) return error;
  if (error instanceof NotFoundProblem) return error;
  if (error instanceof ConflictProblem) return error;
  if (error instanceof GatewayTimeoutProblem) return error;
  if (error instanceof InternalServerProblem) return error;
  if (!hasTag(error)) return internal(correlationId);
  const withCorrelation = correlationId !== undefined ? { correlationId } : {};
  switch (error._tag) {
    case "ValidationFailed": {
      const subject = stringField(error, "subject") ?? "request";
      return new BadRequestProblem({
        error: "ValidationFailed",
        message: `${subject} is invalid`,
        issues: issuesField(error),
        ...withCorrelation,
      });
    }
    case "Unauthorized": {
      const tag = stringField(error, "tag");
      return new ForbiddenProblem({
        error: "Unauthorized",
        message: tag === undefined ? "not allowed" : `not allowed to dispatch "${tag}"`,
        ...withCorrelation,
      });
    }
    case "Unauthenticated":
      return new UnauthorizedProblem({
        error: "Unauthenticated",
        message: "authentication required",
        ...withCorrelation,
      });
    case "PermissionDenied": {
      const permission = stringField(error, "permission");
      return new ForbiddenProblem({
        error: "PermissionDenied",
        message: permission === undefined ? "not allowed" : `not allowed: "${permission}"`,
        ...withCorrelation,
      });
    }
    case "NotFound": {
      const entity = stringField(error, "entity");
      const id = stringField(error, "id");
      return new NotFoundProblem({
        error: "NotFound",
        message:
          entity !== undefined && id !== undefined ? `${entity} ${id} not found` : "not found",
        ...withCorrelation,
      });
    }
    case "HttpApiDecodeError":
      return new BadRequestProblem({
        error: "ValidationFailed",
        message: "request is invalid",
        issues: decodeIssues(error),
        ...withCorrelation,
      });
    case "RouteNotFound":
      return new NotFoundProblem({
        error: "NotFound",
        message: "route not found",
        ...withCorrelation,
      });
    case "ConcurrencyConflict": {
      const entity = stringField(error, "entity");
      const id = stringField(error, "id");
      return new ConflictProblem({
        error: "ConcurrencyConflict",
        message:
          entity !== undefined && id !== undefined
            ? `${entity} ${id} was modified concurrently`
            : "concurrent modification",
        ...withCorrelation,
      });
    }
    case "DispatchTimeout": {
      const tag = stringField(error, "tag");
      return new GatewayTimeoutProblem({
        error: "DispatchTimeout",
        message: tag === undefined ? "request timed out" : `"${tag}" timed out`,
        ...withCorrelation,
      });
    }
    default:
      return internal(correlationId);
  }
};

/** Renders a problem as an `HttpServerResponse` with its annotated status. */
export const problemResponse = (problem: HttpProblem): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.unsafeJson(
    {
      error: problem.error,
      message: problem.message,
      ...(problem.correlationId !== undefined && { correlationId: problem.correlationId }),
      ...(problem.issues !== undefined && { issues: problem.issues }),
    },
    { status: problemStatus(problem) },
  );

/**
 * One-step mapping from any error (or defect value) to a ready-to-send
 * problem response.
 */
export const defaultErrorResponse = (
  error: unknown,
  correlationId?: string,
): HttpServerResponse.HttpServerResponse => problemResponse(toProblem(error, correlationId));
