import { expect, test } from "bun:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { Effect, Schema, Stream } from "effect";
import { Probe, type Text, TextSchema } from "../examples/probe_pb.js";
import {
  businessFailure,
  type Client,
  type GrpcError,
  type Handlers,
  service,
} from "../src/index.js";

const handlers: Handlers<typeof Probe> = {
  unary: (r) => Effect.succeed(r),
  watch: (r) => Stream.succeed(r),
  upload: () => Effect.succeed(create(TextSchema)),
  chat: (input) => input,
};
// Checked by tsc; these contracts must reject an invalid handler or call definition.
const typeChecks = (client: Client<typeof Probe>) => {
  // @ts-expect-error A protobuf request needs its generated message shape.
  client.unary({ value: 1 });
  // @ts-expect-error Server-streaming handlers must return the generated response shape.
  service(Probe, { ...handlers, watch: () => Stream.succeed("invalid") });
  // @ts-expect-error Client-streaming takes an input stream.
  client.upload(create(TextSchema));
  // @ts-expect-error Every method needs a handler.
  service(Probe, { unary: handlers.unary });
  const unary: Effect.Effect<Text, GrpcError> = client.unary(create(TextSchema));
  const watch: Stream.Stream<Text, GrpcError> = client.watch(create(TextSchema));
  return [unary, watch];
};
const failure = businessFailure(Schema.Struct({ reason: Schema.String }), {
  encode: (v) => toBinary(TextSchema, create(TextSchema, { value: v.reason })),
  decode: (bytes) => ({ reason: fromBinary(TextSchema, bytes).value }),
});
const failureTypes = (client: Client<typeof Probe, { unary: typeof failure }>) => {
  const typed: Effect.Effect<Text, GrpcError | { readonly reason: string }> = client.unary(
    create(TextSchema),
  );
  // @ts-expect-error Declared business failures cannot be erased from the error channel.
  const invalid: Effect.Effect<Text, GrpcError> = typed;
  return invalid;
};
test("generated protobuf has stable field numbers and round-trips", () => {
  expect(TextSchema.field.value.number).toBe(1);
  expect(
    fromBinary(TextSchema, toBinary(TextSchema, create(TextSchema, { value: "x" }))).value,
  ).toBe("x");
  expect(typeof typeChecks).toBe("function");
  expect(typeof failureTypes).toBe("function");
});
