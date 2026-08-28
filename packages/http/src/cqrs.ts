import * as HttpApiEndpoint from "@effect/platform/HttpApiEndpoint";
import * as HttpApiSchema from "@effect/platform/HttpApiSchema";
import type * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import {
  type AnyMessageDefinition,
  CommandBus,
  type CommandDefinition,
  type DispatchOptions,
  QueryBus,
  type QueryDefinition,
} from "@structure-ai/cqrs";
import { Correlation } from "@structure-ai/observability";
import { Data, type Duration, Effect, ParseResult, Schema } from "effect";
import * as AST from "effect/SchemaAST";
import { type HttpProblem, toProblem, withDefaultErrors } from "./errors.js";

/** HTTP status every declared business failure is served with. */
const businessFailureStatus = 422;

/**
 * Internal marker the bridge fails with instead of a declared business
 * failure. The `problems` middleware unwraps it and re-fails the inner error
 * unchanged, so the platform encodes it through the endpoint's declared
 * failure schema — instead of taxonomy-mapping its `_tag` to a problem —
 * while undeclared taxonomy escapes keep their problem rendering. Never
 * reaches the wire; requires the standard middleware stack (`serve` and
 * `serveTest` provide it).
 */
export class DeclaredBusinessFailure extends Data.TaggedError("DeclaredBusinessFailure")<{
  readonly failure: unknown;
}> {}

/**
 * Stamps {@link businessFailureStatus} onto every member of a failure schema.
 * Member-level annotation is required: status resolution walks union members,
 * so annotating the union itself is ignored and members would default to 500.
 * Existing member annotations are preserved (this only adds the status).
 */
const annotateFailure = (failure: Schema.Schema.All): Schema.Schema.All => {
  const status = HttpApiSchema.annotations({ status: businessFailureStatus });
  const ast = failure.ast;
  return Schema.make(
    AST.isUnion(ast)
      ? AST.Union.make(ast.types.map((member) => AST.annotations(member, status)))
      : AST.annotations(ast, status),
  );
};

/**
 * Adds the (422-annotated) failure schema to an endpoint. The awkward cast
 * exists because `addError`'s precise type cannot be expressed against an
 * abstract endpoint value; the overload signatures above each call site keep
 * the public types honest.
 */
const declareFailure = (
  endpoint: { addError: (schema: Schema.Schema.All) => unknown },
  failure: Schema.Schema.All | undefined,
): unknown => (failure === undefined ? endpoint : endpoint.addError(annotateFailure(failure)));

/**
 * Options for the HTTP → CQRS bridge. Kept deliberately small: the bus owns
 * validation, authorization, idempotency and metrics; the bridge only carries
 * the transport-level facts across.
 */
export interface BridgeOptions {
  /**
   * Extracts the acting principal from the request (e.g. from a verified
   * auth header). When it returns `undefined` the dispatch falls back to the
   * actor already present on the ambient correlation context.
   */
  readonly actor?: (request: HttpServerRequest.HttpServerRequest) => string | undefined;
  /** Deadline for the dispatch; exceeding it maps to a 504 response. */
  readonly timeout?: Duration.DurationInput;
}

/** The request shape the bridge handlers accept (payload + raw request). */
export interface BridgeRequest<PayloadEncoded> {
  readonly payload: PayloadEncoded;
  readonly request: HttpServerRequest.HttpServerRequest;
}

const dispatchOptions = (
  options: BridgeOptions | undefined,
  request: HttpServerRequest.HttpServerRequest,
): DispatchOptions => {
  const actor = options?.actor?.(request);
  const idempotencyKey = request.headers["x-idempotency-key"];
  return {
    ...(actor !== undefined && { actor }),
    ...(options?.timeout !== undefined && { timeout: options.timeout }),
    ...(idempotencyKey !== undefined && { idempotencyKey }),
  };
};

const failWithProblem = (error: unknown): Effect.Effect<never, HttpProblem> =>
  Effect.flatMap(Correlation.current, (context) =>
    Effect.fail(toProblem(error, context.correlationId)),
  );

/**
 * Builds the dispatch-error handler shared by the command and query bridges:
 * declared business failures travel on (wrapped in the internal marker, see
 * {@link DeclaredBusinessFailure}), everything else becomes a problem.
 */
const bridgeErrorHandler =
  <FailureType, FailureEncoded>(failure: Schema.Schema<FailureType, FailureEncoded> | undefined) =>
  (error: unknown): Effect.Effect<never, HttpProblem | FailureType> => {
    const declared = failure !== undefined && ParseResult.is(failure)(error);
    return declared
      ? Effect.fail(new DeclaredBusinessFailure({ failure: error }) as unknown as FailureType)
      : failWithProblem(error);
  };

/**
 * Turns a command definition into an `HttpApiBuilder` endpoint handler:
 * decoded wire payload in, dispatch on the `CommandBus`, typed success out.
 * Declared business failures surface as typed endpoint errors (422); every
 * other dispatch error is mapped to a problem response.
 *
 * ```ts
 * HttpApiBuilder.group(api, "items", (handlers) =>
 *   handlers.handle("addItem", HttpCqrs.command(AddItem)),
 * )
 * ```
 */
export const command =
  <
    Tag extends string,
    PayloadType,
    PayloadEncoded,
    SuccessType,
    SuccessEncoded,
    FailureType,
    FailureEncoded,
  >(
    definition: CommandDefinition<
      Tag,
      PayloadType,
      PayloadEncoded,
      SuccessType,
      SuccessEncoded,
      FailureType,
      FailureEncoded
    >,
    options?: BridgeOptions,
  ) =>
  (
    request: BridgeRequest<PayloadEncoded>,
  ): Effect.Effect<SuccessType, HttpProblem | FailureType, CommandBus> =>
    Effect.flatMap(CommandBus, (bus) =>
      bus
        .dispatch(definition, request.payload, dispatchOptions(options, request.request))
        .pipe(Effect.catchAll(bridgeErrorHandler(definition.failure))),
    );

/**
 * Turns a query definition into an `HttpApiBuilder` endpoint handler. For
 * GET endpoints the payload decodes from the url search parameters. Declared
 * business failures surface as typed endpoint errors (422); every other
 * dispatch error is mapped to a problem response.
 */
export const query =
  <
    Tag extends string,
    PayloadType,
    PayloadEncoded,
    SuccessType,
    SuccessEncoded,
    FailureType,
    FailureEncoded,
  >(
    definition: QueryDefinition<
      Tag,
      PayloadType,
      PayloadEncoded,
      SuccessType,
      SuccessEncoded,
      FailureType,
      FailureEncoded
    >,
    options?: BridgeOptions,
  ) =>
  (
    request: BridgeRequest<PayloadEncoded>,
  ): Effect.Effect<SuccessType, HttpProblem | FailureType, QueryBus> =>
    Effect.flatMap(QueryBus, (bus) =>
      bus
        .dispatch(definition, request.payload, dispatchOptions(options, request.request))
        .pipe(Effect.catchAll(bridgeErrorHandler(definition.failure))),
    );

/**
 * Declares a POST endpoint for a command: the wire payload schema is the
 * *encoded* side of the definition's payload (deep validation happens once,
 * on the bus, so refinements surface as 400 problems with issue lists), the
 * success schema is the definition's, and the standard problem responses are
 * declared for OpenAPI.
 *
 * When the definition declares a `failure` schema, that schema is declared as
 * an endpoint error (annotated 422), so clients and `openapi.json` know the
 * business failures the command can produce.
 *
 * ```ts
 * const items = ApiGroup.make("items")
 *   .add(HttpCqrs.commandEndpoint("addItem", "/items", AddItem));
 * ```
 */
export function commandEndpoint<
  const Name extends string,
  Tag extends string,
  PayloadType,
  PayloadEncoded,
  SuccessType,
  SuccessEncoded,
>(
  name: Name,
  path: HttpApiEndpoint.PathSegment,
  definition: CommandDefinition<
    Tag,
    PayloadType,
    PayloadEncoded,
    SuccessType,
    SuccessEncoded,
    never,
    never
  >,
): HttpApiEndpoint.HttpApiEndpoint<
  Name,
  "POST",
  never,
  never,
  PayloadEncoded,
  never,
  SuccessType,
  HttpProblem,
  never,
  never
>;
export function commandEndpoint<
  const Name extends string,
  Tag extends string,
  PayloadType,
  PayloadEncoded,
  SuccessType,
  SuccessEncoded,
  FailureType,
  FailureEncoded,
>(
  name: Name,
  path: HttpApiEndpoint.PathSegment,
  definition: CommandDefinition<
    Tag,
    PayloadType,
    PayloadEncoded,
    SuccessType,
    SuccessEncoded,
    FailureType,
    FailureEncoded
  >,
): HttpApiEndpoint.HttpApiEndpoint<
  Name,
  "POST",
  never,
  never,
  PayloadEncoded,
  never,
  SuccessType,
  HttpProblem | FailureType,
  never,
  never
>;
export function commandEndpoint(
  name: string,
  path: HttpApiEndpoint.PathSegment,
  definition: AnyMessageDefinition,
): unknown {
  return declareFailure(
    withDefaultErrors(
      HttpApiEndpoint.post(name, path)
        .setPayload(Schema.encodedSchema(definition.payload as Schema.Schema.Any))
        .addSuccess(definition.success as Schema.Schema.Any),
    ) as { addError: (schema: Schema.Schema.All) => unknown },
    definition.failure === undefined ? undefined : definition.failure,
  );
}

/**
 * Declares a GET endpoint for a query. The encoded payload decodes from the
 * url search parameters, so every encoded field must be a string (or array of
 * strings); build the endpoint manually for anything richer. A declared
 * `failure` schema becomes a declared endpoint error (annotated 422).
 */
export function queryEndpoint<
  const Name extends string,
  Tag extends string,
  PayloadType,
  PayloadEncoded extends Readonly<Record<string, string | ReadonlyArray<string> | undefined>>,
  SuccessType,
  SuccessEncoded,
>(
  name: Name,
  path: HttpApiEndpoint.PathSegment,
  definition: QueryDefinition<
    Tag,
    PayloadType,
    PayloadEncoded,
    SuccessType,
    SuccessEncoded,
    never,
    never
  >,
): HttpApiEndpoint.HttpApiEndpoint<
  Name,
  "GET",
  never,
  never,
  PayloadEncoded,
  never,
  SuccessType,
  HttpProblem,
  never,
  never
>;
export function queryEndpoint<
  const Name extends string,
  Tag extends string,
  PayloadType,
  PayloadEncoded extends Readonly<Record<string, string | ReadonlyArray<string> | undefined>>,
  SuccessType,
  SuccessEncoded,
  FailureType,
  FailureEncoded,
>(
  name: Name,
  path: HttpApiEndpoint.PathSegment,
  definition: QueryDefinition<
    Tag,
    PayloadType,
    PayloadEncoded,
    SuccessType,
    SuccessEncoded,
    FailureType,
    FailureEncoded
  >,
): HttpApiEndpoint.HttpApiEndpoint<
  Name,
  "GET",
  never,
  never,
  PayloadEncoded,
  never,
  SuccessType,
  HttpProblem | FailureType,
  never,
  never
>;
export function queryEndpoint(
  name: string,
  path: HttpApiEndpoint.PathSegment,
  definition: AnyMessageDefinition,
): unknown {
  // `ValidatePayload` cannot resolve against an abstract `PayloadEncoded`,
  // so the schema is pinned to a concrete string-record type for the call and
  // the endpoint is cast back. The generic bound on `PayloadEncoded` enforces
  // exactly the constraint `ValidatePayload` would have checked.
  const payload = Schema.encodedSchema(
    definition.payload as Schema.Schema.Any,
  ) as unknown as Schema.Schema<Readonly<Record<string, string | undefined>>>;
  return declareFailure(
    withDefaultErrors(
      HttpApiEndpoint.get(name, path)
        .setPayload(payload)
        .addSuccess(definition.success as Schema.Schema.Any),
    ) as {
      addError: (schema: Schema.Schema.All) => unknown;
    },
    definition.failure === undefined ? undefined : definition.failure,
  );
}
