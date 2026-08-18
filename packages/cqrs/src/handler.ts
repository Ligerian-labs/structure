import { Context, Effect, Layer } from "effect";
import type {
  AnyMessageDefinition,
  CommandDefinition,
  Dispatch,
  QueryDefinition,
} from "./message.js";

/**
 * One registered handler: the message definition it serves and the
 * type-erased handler function. The erased payload/result types are safe
 * because a registration can only be produced by `CommandHandler.make` /
 * `QueryHandler.make`, which tie the handler to its definition's schemas.
 * `R` tracks the services the handler still needs; `HandlerRegistry.layer`
 * resolves them at layer build time.
 */
export interface Registration<R = never> {
  readonly definition: AnyMessageDefinition;
  readonly handler: (payload: unknown, dispatch: Dispatch) => Effect.Effect<unknown, unknown, R>;
}

/** Union of the service requirements of a set of registrations. */
export type RegistrationContext<Reg> = Reg extends Registration<infer R> ? R : never;

const makeRegistration = <PayloadType, SuccessType, FailureType, R>(
  definition: AnyMessageDefinition,
  handler: (payload: PayloadType, dispatch: Dispatch) => Effect.Effect<SuccessType, FailureType, R>,
): Registration<R> => ({
  definition,
  // Erasure is sound: the bus only calls this handler with a payload decoded
  // by `definition.payload`, which is exactly `PayloadType`.
  handler: handler as unknown as Registration<R>["handler"],
});

/**
 * Binds a handler to a command definition. There must be exactly one
 * handler per command; the payload the handler receives has already been
 * decoded at the boundary, and the `Dispatch` envelope carries identity,
 * correlation, actor and idempotency key.
 */
export const CommandHandler = {
  make: <
    Tag extends string,
    PayloadType,
    PayloadEncoded,
    SuccessType,
    SuccessEncoded,
    FailureType,
    FailureEncoded,
    R = never,
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
    handler: (
      payload: PayloadType,
      dispatch: Dispatch,
    ) => Effect.Effect<SuccessType, FailureType, R>,
  ): Registration<R> => makeRegistration(definition, handler),
} as const;

/**
 * Binds a handler to a query definition. Query handlers must be read-only:
 * the bus assumes they can run any number of times without effect on state.
 */
export const QueryHandler = {
  make: <
    Tag extends string,
    PayloadType,
    PayloadEncoded,
    SuccessType,
    SuccessEncoded,
    FailureType,
    FailureEncoded,
    R = never,
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
    handler: (
      payload: PayloadType,
      dispatch: Dispatch,
    ) => Effect.Effect<SuccessType, FailureType, R>,
  ): Registration<R> => makeRegistration(definition, handler),
} as const;

/**
 * Holds every registered handler, keyed by message tag. Built once at layer
 * construction; the buses look handlers up here per dispatch.
 */
export class HandlerRegistry extends Context.Tag("@structure/cqrs/HandlerRegistry")<
  HandlerRegistry,
  ReadonlyMap<string, Registration>
>() {
  /**
   * Collects registrations into the registry service. The handlers'
   * service requirements become requirements of the returned layer and are
   * captured once at build time. Registering two handlers for the same tag
   * is a wiring bug and dies (defect, not a typed failure) when the layer
   * is built.
   */
  static layer<const Regs extends ReadonlyArray<Registration<unknown>>>(
    ...registrations: Regs
  ): Layer.Layer<HandlerRegistry, never, RegistrationContext<Regs[number]>> {
    return Layer.effect(
      HandlerRegistry,
      Effect.gen(function* () {
        const context = yield* Effect.context<RegistrationContext<Regs[number]>>();
        const map = new Map<string, Registration>();
        for (const registration of registrations) {
          const tag = registration.definition.tag;
          if (map.has(tag)) {
            return yield* Effect.die(
              new Error(`duplicate handler registration for message tag "${tag}"`),
            );
          }
          map.set(tag, {
            definition: registration.definition,
            handler: (payload, dispatch) =>
              // The layer's requirements are exactly the handlers' union, so
              // providing the captured context leaves no requirement behind.
              Effect.provide(registration.handler(payload, dispatch), context) as Effect.Effect<
                unknown,
                unknown
              >,
          });
        }
        return map;
      }),
    );
  }
}
