import type * as HttpApiEndpoint from "@effect/platform/HttpApiEndpoint";
import { HttpApiDecodeError } from "@effect/platform/HttpApiError";
import * as HttpApiSchema from "@effect/platform/HttpApiSchema";
import type { HttpMethod } from "@effect/platform/HttpMethod";
import { RouteNotFound } from "@effect/platform/HttpServerError";
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

/** 429: rate limit exceeded; retry after the advertised delay. */
export class TooManyRequestsProblem extends Schema.Class<TooManyRequestsProblem>(
  "TooManyRequestsProblem",
)(problemFields, HttpApiSchema.annotations({ status: 429 })) {}

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
  | TooManyRequestsProblem
  | GatewayTimeoutProblem
  | InternalServerProblem;

/** Schema union of all problems — usable with `addError` on api/group/endpoint. */
export const HttpProblemSchema = Schema.Union(
  BadRequestProblem,
  UnauthorizedProblem,
  ForbiddenProblem,
  NotFoundProblem,
  ConflictProblem,
  TooManyRequestsProblem,
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
              : problem instanceof TooManyRequestsProblem
                ? TooManyRequestsProblem
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

// Authorization is composed by apps, so validate its public contract here without
// adding a dependency from HTTP to authorization. A tag alone is insufficient.
const taxonomy = Schema.Union(
  Schema.Struct({
    _tag: Schema.Literal("ValidationFailed"),
    subject: Schema.String,
    issues: Schema.Array(Schema.String),
  }),
  Schema.Struct({ _tag: Schema.Literal("Unauthorized"), tag: Schema.String }),
  Schema.Struct({
    _tag: Schema.Literal("Unauthenticated"),
    permission: Schema.optional(Schema.String),
    reason: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    _tag: Schema.Literal("PermissionDenied"),
    permission: Schema.String,
    principal: Schema.String,
  }),
  Schema.Struct({ _tag: Schema.Literal("NotFound"), entity: Schema.String, id: Schema.String }),
  Schema.Struct({
    _tag: Schema.Literal("ConcurrencyConflict"),
    entity: Schema.String,
    id: Schema.String,
    expectedVersion: Schema.Number,
    actualVersion: Schema.Number,
  }),
  Schema.Struct({
    _tag: Schema.Literal("IdempotencyMismatch", "IdempotencyInFlight"),
    tag: Schema.String,
    key: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.Literal("DispatchTimeout"),
    tag: Schema.String,
    timeoutMillis: Schema.Number,
  }),
  Schema.Struct({ _tag: Schema.Literal("InvariantViolation"), rule: Schema.String }),
  Schema.Struct({
    _tag: Schema.Literal("HandlerNotFound"),
    tag: Schema.String,
    kind: Schema.Literal("command", "query"),
  }),
);
const isTaxonomyError = Schema.is(taxonomy);

/** Validated framework failures handled by the problem boundary. */
export const isKnownError = (error: unknown): boolean =>
  HttpProblemSchema.members.some((member) => error instanceof member) ||
  error instanceof HttpApiDecodeError ||
  error instanceof RouteNotFound ||
  isTaxonomyError(error);

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
 * - `IdempotencyMismatch` → 409 (key reused with another payload)
 * - `IdempotencyInFlight` → 409 (same key still running; retry later)
 * - `DispatchTimeout`  → 504
 * - `RouteNotFound`    → 404
 * - anything else (including defects) → 500 with the correlation id only
 *
 * Structural taxonomy errors are validated against their fields before mapping.
 * Platform errors use their constructors; a matching tag alone is insufficient.
 */
export const toProblem = (error: unknown, correlationId?: string): HttpProblem => {
  if (error instanceof BadRequestProblem) return error;
  if (error instanceof UnauthorizedProblem) return error;
  if (error instanceof ForbiddenProblem) return error;
  if (error instanceof NotFoundProblem) return error;
  if (error instanceof ConflictProblem) return error;
  if (error instanceof GatewayTimeoutProblem) return error;
  if (error instanceof InternalServerProblem) return error;
  if (error instanceof TooManyRequestsProblem) return error;
  const withCorrelation = correlationId !== undefined ? { correlationId } : {};
  if (error instanceof HttpApiDecodeError)
    return new BadRequestProblem({
      error: "ValidationFailed",
      message: "request is invalid",
      issues: error.issues.map(
        (issue) => `${issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""}${issue.message}`,
      ),
      ...withCorrelation,
    });
  if (error instanceof RouteNotFound)
    return new NotFoundProblem({
      error: "NotFound",
      message: "route not found",
      ...withCorrelation,
    });
  if (!isTaxonomyError(error)) return internal(correlationId);
  switch (error._tag) {
    case "ValidationFailed": {
      const subject = error.subject;
      return new BadRequestProblem({
        error: "ValidationFailed",
        message: `${subject} is invalid`,
        issues: error.issues,
        ...withCorrelation,
      });
    }
    case "Unauthorized": {
      const tag = error.tag;
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
      const permission = error.permission;
      return new ForbiddenProblem({
        error: "PermissionDenied",
        message: permission === undefined ? "not allowed" : `not allowed: "${permission}"`,
        ...withCorrelation,
      });
    }
    case "NotFound": {
      const entity = error.entity;
      const id = error.id;
      return new NotFoundProblem({
        error: "NotFound",
        message:
          entity !== undefined && id !== undefined ? `${entity} ${id} not found` : "not found",
        ...withCorrelation,
      });
    }
    case "ConcurrencyConflict": {
      const entity = error.entity;
      const id = error.id;
      return new ConflictProblem({
        error: "ConcurrencyConflict",
        message:
          entity !== undefined && id !== undefined
            ? `${entity} ${id} was modified concurrently`
            : "concurrent modification",
        ...withCorrelation,
      });
    }
    case "IdempotencyMismatch":
      return new ConflictProblem({
        error: "IdempotencyMismatch",
        message: "idempotency key was already used with a different payload",
        ...withCorrelation,
      });
    case "IdempotencyInFlight":
      return new ConflictProblem({
        error: "IdempotencyInFlight",
        message: "a request with this idempotency key is still in progress",
        ...withCorrelation,
      });
    case "DispatchTimeout": {
      const tag = error.tag;
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
