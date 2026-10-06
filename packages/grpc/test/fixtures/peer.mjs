import { createServer } from "node:http2";
import { create } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import {
  connectNodeAdapter,
  createGrpcTransport,
  Http2SessionManager,
} from "@connectrpc/connect-node";
import { Probe, TextSchema } from "./probe_pb.js";

const text = (value) => create(TextSchema, { value });
if (process.argv[2] === "server") {
  const adapter = connectNodeAdapter({
    grpc: true,
    grpcWeb: false,
    connect: false,
    routes: (router) =>
      router.service(Probe, {
        unary: (r) => text(`echo:${r.value}`),
        watch: async function* () {
          yield text("1");
          yield text("2");
          yield text("3");
        },
        upload: async (input) => {
          const out = [];
          for await (const r of input) out.push(r.value);
          return text(out.join(","));
        },
        chat: async function* (input) {
          yield text("ready");
          for await (const r of input) yield text(`echo:${r.value}`);
        },
      }),
  });
  const server = createServer(adapter);
  server.listen(0, "127.0.0.1", () => console.log(server.address().port));
  process.on("SIGTERM", () => {
    server.close();
    process.exit(0);
  });
} else {
  const url = `http://${process.argv[3]}`;
  const manager = new Http2SessionManager(url);
  const client = createClient(
    Probe,
    createGrpcTransport({ baseUrl: url, sessionManager: manager }),
  );
  try {
    const unary = await client.unary(text("x"));
    const watch = [];
    for await (const r of client.watch(text("x"))) watch.push(r.value);
    const input = async function* () {
      yield text("a");
      yield text("b");
    };
    const upload = await client.upload(input());
    const chat = [];
    for await (const r of client.chat(input())) chat.push(r.value);
    console.log(JSON.stringify({ unary: unary.value, watch, upload: upload.value, chat }));
  } finally {
    manager.abort();
  }
}
