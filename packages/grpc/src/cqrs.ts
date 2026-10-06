import {
  CommandBus,
  type CommandDefinition,
  type DispatchOptions,
  QueryBus,
  type QueryDefinition,
} from "@structure-ai/cqrs";
import { Effect } from "effect";
import type { RequestContext } from "./contract.js";
import { GrpcError, Status } from "./errors.js";

export interface BridgeMapping<Request, PayloadEncoded, Success, Response> {
  readonly payload: (request: Request) => PayloadEncoded;
  readonly response: (success: Success) => Response;
}
const dispatchOptions = (context: RequestContext): Effect.Effect<DispatchOptions, GrpcError> =>
  Effect.gen(function* () {
    const remaining = yield* context.remainingMs;
    if (remaining <= 0)
      return yield* Effect.fail(new GrpcError({ code: Status.DEADLINE_EXCEEDED }));
    const idempotencyKey = context.metadata.text("x-idempotency-key");
    return {
      ...(context.actor === undefined ? {} : { actor: context.actor }),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      ...(Number.isFinite(remaining) ? { timeout: remaining } : {}),
    };
  });
/** Unary protobuf-to-command adapter. Validation, policy and deduplication remain bus-owned. */
export const command =
  <Tag extends string, P, PI, A, AI, E, EI, Request, Response>(
    definition: CommandDefinition<Tag, P, PI, A, AI, E, EI>,
    mapping: BridgeMapping<Request, PI, A, Response>,
  ) =>
  (request: Request, context: RequestContext) =>
    Effect.gen(function* () {
      const options = yield* dispatchOptions(context);
      const bus = yield* CommandBus;
      return mapping.response(yield* bus.dispatch(definition, mapping.payload(request), options));
    });
/** Unary protobuf-to-query adapter. Queries never acquire command idempotency behavior. */
export const query =
  <Tag extends string, P, PI, A, AI, E, EI, Request, Response>(
    definition: QueryDefinition<Tag, P, PI, A, AI, E, EI>,
    mapping: BridgeMapping<Request, PI, A, Response>,
  ) =>
  (request: Request, context: RequestContext) =>
    Effect.gen(function* () {
      const options = yield* dispatchOptions(context);
      const bus = yield* QueryBus;
      return mapping.response(yield* bus.dispatch(definition, mapping.payload(request), options));
    });
