import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Readiness, Shutdown } from "@structure-ai/runtime";
import { Chunk, Effect, Layer, Stream } from "effect";
import { Probe, TextSchema } from "../examples/probe_pb.js";
import { makeClient, makeServer, service } from "../src/index.js";

const peer = new URL("./fixtures/peer.mjs", import.meta.url).pathname;
// Default requires only Bun; opt into an independently hosted Node peer when available.
const peerCommand =
  process.env.GRPC_TEST_NODE === "1"
    ? [Bun.which("node") ?? "node", peer]
    : [process.execPath, peer];
const text = (value: string) => create(TextSchema, { value });
const runtime = Shutdown.layer().pipe(Layer.provideMerge(Readiness.layer));
const expected = {
  unary: "echo:x",
  watch: ["1", "2", "3"],
  upload: "a,b",
  chat: ["ready", "echo:a", "echo:b"],
};

test(
  "Structure server interoperates with independent Connect native gRPC client for all RPC kinds",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* makeServer(
            [
              service(Probe, {
                unary: (r) => Effect.succeed(text(`echo:${r.value}`)),
                watch: () => Stream.make(text("1"), text("2"), text("3")),
                upload: (input) =>
                  input.pipe(
                    Stream.runCollect,
                    Effect.map((values) =>
                      text(
                        Chunk.toArray(values)
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
              }),
            ],
            { address: "127.0.0.1:0", security: { mode: "insecure" } },
          );
          const process = yield* Effect.acquireRelease(
            Effect.sync(() =>
              Bun.spawn([...peerCommand, "client", server.address], {
                stdout: "pipe",
                stderr: "pipe",
              }),
            ),
            (child) => Effect.sync(() => child.kill()),
          );
          const output = yield* Effect.promise(() => new Response(process.stdout).text());
          const error = yield* Effect.promise(() => new Response(process.stderr).text());
          expect(yield* Effect.promise(() => process.exited)).toBe(0);
          expect(error).toBe("");
          expect(JSON.parse(output)).toEqual(expected);
        }),
      ).pipe(Effect.provide(runtime)),
    ),
  10000,
);

test(
  "Structure client interoperates with independent Connect native gRPC server for all RPC kinds",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const child = yield* Effect.acquireRelease(
            Effect.sync(() =>
              Bun.spawn([...peerCommand, "server"], {
                stdout: "pipe",
                stderr: "pipe",
              }),
            ),
            (child) =>
              Effect.promise(async () => {
                child.kill();
                await child.exited;
              }),
          );
          const reader = child.stdout.getReader();
          const first = yield* Effect.promise(() => reader.read());
          reader.releaseLock();
          const port = Number(new TextDecoder().decode(first.value).trim());
          expect(port).toBeGreaterThan(0);
          const client = yield* makeClient(Probe, {
            address: `127.0.0.1:${port}`,
            security: { mode: "insecure" },
          });
          const unary = (yield* client.unary(text("x"))).value;
          const watch = Chunk.toArray(yield* Stream.runCollect(client.watch(text("x")))).map(
            (r) => r.value,
          );
          const upload = (yield* client.upload(Stream.make(text("a"), text("b")))).value;
          const chat = Chunk.toArray(
            yield* Stream.runCollect(client.chat(Stream.make(text("a"), text("b")))),
          ).map((r) => r.value);
          expect({ unary, watch, upload, chat }).toEqual(expected);
        }),
      ),
    ),
  10000,
);
