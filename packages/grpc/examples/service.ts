import { create } from "@bufbuild/protobuf";
import { Chunk, Effect, Stream } from "effect";
import { service } from "../src/index.js";
import { Probe, TextSchema } from "./probe_pb.js";
export const text = (value: string) => create(TextSchema, { value });
export const handlers = {
  unary: (request) => Effect.succeed(text(`echo:${request.value}`)),
  watch: () => Stream.make(text("1"), text("2"), text("3")),
  upload: (input) =>
    input.pipe(
      Stream.runCollect,
      Effect.map((messages) =>
        text(
          Chunk.toArray(messages)
            .map((r) => r.value)
            .join(","),
        ),
      ),
    ),
  chat: (input) =>
    Stream.concat(
      Stream.succeed(text("ready")),
      Stream.map(input, (r) => text(`echo:${r.value}`)),
    ),
} satisfies import("../src/index.js").Handlers<typeof Probe>;
export const probe = service(Probe, handlers);
