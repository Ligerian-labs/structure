import {
  type DescMethod,
  type DescService,
  fromBinary,
  type MessageShape,
  toBinary,
} from "@bufbuild/protobuf";
import type { MethodDefinition } from "@grpc/grpc-js";
import { Effect, Option, Schema, type Stream } from "effect";
import { GrpcError, Status } from "./errors.js";
import type { Metadata } from "./metadata.js";

export interface Codec<A> {
  readonly encode: (value: A) => Uint8Array;
  readonly decode: (bytes: Uint8Array) => A;
}
export interface FailureContract<E> {
  readonly encode: (error: unknown) => Option.Option<Uint8Array>;
  readonly decode: (bytes: Uint8Array) => Effect.Effect<E, GrpcError>;
}
/** A protobuf codec for the encoded side of an Effect schema. No implicit JSON errors. */
export const businessFailure = <E, Wire>(
  schema: Schema.Schema<E, Wire>,
  codec: Codec<Wire>,
): FailureContract<E> => ({
  encode: (error) => {
    try {
      return Option.some(
        codec.encode(
          Schema.encodeSync(schema)(Schema.decodeUnknownSync(Schema.typeSchema(schema))(error)),
        ),
      );
    } catch {
      return Option.none();
    }
  },
  decode: (bytes) =>
    Effect.try({
      try: () => Schema.decodeUnknownSync(schema)(codec.decode(bytes)),
      catch: () => new GrpcError({ code: Status.INTERNAL }),
    }),
});
export interface RequestContext {
  readonly service: string;
  readonly method: string;
  readonly metadata: Metadata;
  readonly correlationId: string;
  /** Only set from the application verification hook. */
  readonly actor: string | undefined;
  readonly deadline: number;
  readonly remainingMs: Effect.Effect<number>;
  readonly sendHeaders: (metadata: Metadata) => Effect.Effect<void, GrpcError>;
  readonly setTrailers: (metadata: Metadata) => Effect.Effect<void>;
}
export type Input<M extends DescMethod> = MessageShape<M["input"]>;
export type Output<M extends DescMethod> = MessageShape<M["output"]>;
export type Handlers<S extends DescService, R = never> = {
  readonly [K in keyof S["method"]]: (
    request: S["method"][K]["methodKind"] extends "client_streaming" | "bidi_streaming"
      ? Stream.Stream<Input<S["method"][K]>, GrpcError>
      : Input<S["method"][K]>,
    context: RequestContext,
  ) => S["method"][K]["methodKind"] extends "server_streaming" | "bidi_streaming"
    ? Stream.Stream<Output<S["method"][K]>, unknown, R>
    : Effect.Effect<Output<S["method"][K]>, unknown, R>;
};
export type FailureContracts<S extends DescService> = Partial<
  Record<keyof S["method"], FailureContract<unknown>>
>;
export interface ServiceRegistration<R = never> {
  readonly descriptor: DescService;
  readonly handlers: Readonly<
    Record<
      string,
      (
        request: unknown,
        context: RequestContext,
      ) => Effect.Effect<unknown, unknown, R> | Stream.Stream<unknown, unknown, R>
    >
  >;
  readonly failures: Readonly<Record<string, FailureContract<unknown>>>;
}
type Requirements<H> = {
  [K in keyof H]: H[K] extends (...args: never[]) => infer O
    ? O extends
        | Effect.Effect<infer _A, infer _E, infer R>
        | Stream.Stream<infer _B, infer _F, infer R>
      ? R
      : never
    : never;
}[keyof H];
/** Registers every generated method and infers the handler service requirements. */
export const service = <S extends DescService, H extends Handlers<NoInfer<S>, unknown>>(
  descriptor: S,
  handlers: H,
  options?: { readonly failures?: FailureContracts<NoInfer<S>> },
): ServiceRegistration<Requirements<H>> => ({
  descriptor,
  // Existential erasure occurs once at the callback boundary.
  handlers: handlers as ServiceRegistration<Requirements<H>>["handlers"],
  failures: (options?.failures as ServiceRegistration<Requirements<H>>["failures"]) ?? {},
});
export const invalidRequest = Symbol("grpc invalid request");
const serialize = (method: DescMethod, value: unknown, response: boolean): Buffer => {
  try {
    return Buffer.from(
      toBinary(response ? method.output : method.input, value as MessageShape<typeof method.input>),
    );
  } catch {
    throw new Error(response ? "Invalid response" : "Invalid request");
  }
};
export const methodDefinition = (
  service: DescService,
  method: DescMethod,
): MethodDefinition<unknown, unknown> => ({
  path: `/${service.typeName}/${method.name}`,
  requestStream: method.methodKind === "client_streaming" || method.methodKind === "bidi_streaming",
  responseStream:
    method.methodKind === "server_streaming" || method.methodKind === "bidi_streaming",
  requestSerialize: (value) => serialize(method, value, false),
  requestDeserialize: (bytes) => {
    try {
      return fromBinary(method.input, bytes);
    } catch {
      return invalidRequest;
    }
  },
  responseSerialize: (value) => serialize(method, value, true),
  responseDeserialize: (bytes) => fromBinary(method.output, bytes),
});
