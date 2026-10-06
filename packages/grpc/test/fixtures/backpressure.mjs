import * as grpc from "@grpc/grpc-js";

const codec = {
  requestSerialize: (v) => Buffer.from(v),
  requestDeserialize: (v) => v,
  responseSerialize: (v) => Buffer.from(v),
  responseDeserialize: (v) => v,
};
const definition = {
  watch: { ...codec, path: "/probe/Watch", requestStream: false, responseStream: true },
};
const server = new grpc.Server({ "grpc-node.max_session_memory": 8 });
let count = 0;
server.addService(definition, {
  watch: (call) => {
    const send = () => {
      count++;
      call.write(Buffer.alloc(256 * 1024), () => {
        if (!call.cancelled) send();
      });
    };
    send();
  },
});
const port = await new Promise((r, j) =>
  server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (e, p) =>
    e ? j(e) : r(p),
  ),
);
const client = new grpc.Client(`127.0.0.1:${port}`, grpc.credentials.createInsecure(), {
  "grpc-node.max_session_memory": 8,
});
const call = client.makeServerStreamRequest(
  "/probe/Watch",
  codec.requestSerialize,
  codec.responseDeserialize,
  Buffer.alloc(0),
);
call.on("error", () => {});
await new Promise((r) => call.once("readable", r));
await new Promise((r) => setTimeout(r, 80));
const first = count;
await new Promise((r) => setTimeout(r, 100));
const second = count;
console.log(
  JSON.stringify({
    runtime: process.versions.bun ?? process.versions.node,
    first,
    second,
    readableLength: call.readableLength,
    bounded: first === second,
  }),
);
call.cancel();
client.close();
server.forceShutdown();
process.exit(first === second ? 0 : 1);
