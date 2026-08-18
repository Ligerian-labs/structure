import * as HttpApiEndpoint from "@effect/platform/HttpApiEndpoint";
import type * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import {
  CommandBus,
  type CommandDefinition,
  type DispatchOptions,
  QueryBus,
  type QueryDefinition,
} from "@structure-ai/cqrs";
import { Correlation } from "@structure-ai/observability";
import { type Duration, Effect, Schema } from "effect";
import { type HttpProblem, toProblem, withDefaultErrors } from "./errors.js";

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
  return {
    ...(actor !== undefined && { actor }),
    ...(options?.timeout !== undefined && { timeout: options.timeout }),
  };
};

const failWithProblem = (error: unknown): Effect.Effect<never, HttpProblem> =>
  Effect.flatMap(Correlation.current, (context) =>
    Effect.fail(toProblem(error, context.correlationId)),
  );

/**
 * Turns a command definition into an `HttpApiBuilder` endpoint handler:
 * decoded wire payload in, dispatch on the `CommandBus`, typed success out,
 * with every dispatch error mapped to a problem response.
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
  (request: BridgeRequest<PayloadEncoded>): Effect.Effect<SuccessType, HttpProblem, CommandBus> =>
    Effect.flatMap(CommandBus, (bus) =>
      bus
        .dispatch(definition, request.payload, dispatchOptions(options, request.request))
        .pipe(Effect.catchAll(failWithProblem)),
    );

/**
 * Turns a query definition into an `HttpApiBuilder` endpoint handler. For
 * GET endpoints the payload decodes from the url search parameters.
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
  (request: BridgeRequest<PayloadEncoded>): Effect.Effect<SuccessType, HttpProblem, QueryBus> =>
    Effect.flatMap(QueryBus, (bus) =>
      bus
        .dispatch(definition, request.payload, dispatchOptions(options, request.request))
        .pipe(Effect.catchAll(failWithProblem)),
    );

/**
 * Declares a POST endpoint for a command: the wire payload schema is the
 * *encoded* side of the definition's payload (deep validation happens once,
 * on the bus, so refinements surface as 400 problems with issue lists), the
 * success schema is the definition's, and the standard problem responses are
 * declared for OpenAPI.
 *
 * ```ts
 * const items = ApiGroup.make("items")
 *   .add(HttpCqrs.commandEndpoint("addItem", "/items", AddItem));
 * ```
 */
export const commandEndpoint = <
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
) =>
  withDefaultErrors(
    HttpApiEndpoint.post(name, path)
      .setPayload(Schema.encodedSchema(definition.payload))
      .addSuccess(definition.success),
  );

/**
 * Declares a GET endpoint for a query. The encoded payload decodes from the
 * url search parameters, so every encoded field must be a string (or array of
 * strings); build the endpoint manually for anything richer.
 */
export const queryEndpoint = <
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
  HttpProblem,
  never,
  never
> => {
  // `ValidatePayload` cannot resolve against an abstract `PayloadEncoded`,
  // so the schema is pinned to a concrete string-record type for the call and
  // the endpoint is cast back. The generic bound on `PayloadEncoded` enforces
  // exactly the constraint `ValidatePayload` would have checked.
  const payload = Schema.encodedSchema(definition.payload) as unknown as Schema.Schema<
    Readonly<Record<string, string | undefined>>
  >;
  return withDefaultErrors(
    HttpApiEndpoint.get(name, path).setPayload(payload).addSuccess(definition.success),
  ) as unknown as HttpApiEndpoint.HttpApiEndpoint<
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
};
