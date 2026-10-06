# @structure-ai/grpc

Typed native gRPC over HTTP/2 with Effect unary operations and Effect Stream for server, client and bidirectional streaming. `@grpc/grpc-js` owns HTTP/2, TLS, framing and flow control. Protobuf-ES v2 owns protobuf encoding. Structure owns scoped resources, correlation, Effect interruption, safe errors, CQRS forwarding and boundary telemetry.

Use the repository's pinned Bun 1.4.1 runtime. Bun 1.3.14 fails the retained native backpressure reproduction; Node compatibility alone does not establish Bun support. No build step, gRPC-Web, REST transcoding, reflection or load-balancing API.

| Export | Purpose |
| --- | --- |
| `service`, `Handlers`, `ServiceRegistration` | Register generated service contracts and infer handler requirements. |
| `makeServer`, `ServerOptions`, `VerifiedContext`, `RequestContext` | Scoped listener, verification, metadata, deadlines and shutdown. |
| `makeClient`, `Client`, `ClientOptions`, `CallOptions` | Scoped channel with typed Effect calls and Stream operations. |
| `Metadata`, `MetadataValue` | Repeated text and binary metadata. |
| `businessFailure`, `FailureContract`, `FailureContracts`, `Codec` | Explicit schema-validated protobuf business errors. |
| `GrpcCqrs`, `BridgeMapping` | Unary command/query bus adapters. |
| `GrpcError`, `GrpcConfigError`, `Status`, `toStatus` | Safe classified failures and validated framework status mapping. |
| `Security`, `TransportOptions`, `Input`, `Output` | Security/configuration and generated message types. |

## Contracts and generation

Applications own `.proto` files. Assign explicit field numbers, reserve deleted numbers and names, and evolve messages additively. Generate descriptors and message types using the existing Protobuf-ES generator, not Structure tooling:

```proto
syntax = "proto3";
package example.v1;
message Text { string value = 1; }
service Echo {
  rpc Unary(Text) returns (Text);
  rpc Watch(Text) returns (stream Text);
  rpc Upload(stream Text) returns (Text);
  rpc Chat(stream Text) returns (stream Text);
}
```

Install `@bufbuild/protobuf` and development tool `@bufbuild/protoc-gen-es` in your application, with an installed `protoc`. In this package, regenerate the checked-in example from its source:

```sh
protoc -I examples \
  --plugin=protoc-gen-es=node_modules/.bin/protoc-gen-es \
  --es_out=examples --es_opt=target=ts examples/probe.proto
protoc -I examples \
  --plugin=protoc-gen-es=node_modules/.bin/protoc-gen-es \
  --es_out=test/fixtures --es_opt=target=js examples/probe.proto
bun x biome check --write examples/probe_pb.ts test/fixtures/probe_pb.js
```

Generated service descriptors carry each method's input, output and RPC kind. Use `create(TextSchema, { value: "hello" })` to construct typed messages. The adapter derives serializers from the generated descriptors. Applications do not implement transport codecs for normal requests/responses. Unknown protobuf fields follow Protobuf-ES behavior.

See [protobuf field evolution](https://protobuf.dev/programming-guides/proto3/) and [Protobuf-ES generation](https://github.com/bufbuild/protobuf-es/tree/main/packages/protoc-gen-es).

## Server and client

The [server](examples/server.ts), [client](examples/client.ts), [four handler kinds](examples/service.ts) and [CQRS example](examples/cqrs.ts) are runnable and typechecked. From the package directory with the supported Bun runtime:

```sh
bun examples/server.ts       # first terminal, native gRPC on 127.0.0.1:50051
bun examples/client.ts       # second terminal, exercises all four RPC kinds
bun examples/cqrs.ts         # isolated loopback CQRS roundtrip
```

```ts
import { makeServer, makeClient, service } from "@structure-ai/grpc";
import { create } from "@bufbuild/protobuf";
import { Chunk, Effect, Stream } from "effect";
import { Probe, TextSchema } from "./probe_pb.js";

const handlers = service(Probe, {
  unary: (request) => Effect.succeed(request),
  watch: (request) => Stream.make(request, request),
  upload: (requests) => requests.pipe(Stream.runCollect,
    Effect.map((values) => create(TextSchema, {
      value: Chunk.toArray(values).map((r) => r.value).join(","),
    }))),
  chat: (requests) => Stream.concat(
    Stream.succeed(create(TextSchema, { value: "ready" })), requests),
});

const program = Effect.scoped(Effect.gen(function* () {
  const server = yield* makeServer([handlers], {
    address: "127.0.0.1:0", security: { mode: "insecure" },
  });
  const client = yield* makeClient(Probe, {
    address: server.address, security: { mode: "insecure" },
  });
  const response = yield* client.unary(create(TextSchema, { value: "hello" }));
  yield* client.watch(response).pipe(Stream.runDrain);
}));
// Provide Readiness and Shutdown, as examples/server.ts demonstrates.
```

Unary and upload return `Effect<Response, GrpcError | DeclaredFailure | ProducerError>`; watch and chat return `Stream<Response, ...>`. Input streams preserve their own errors and service requirements. Handler requirements are inferred by `service` and captured at server acquisition. Missing methods and wrong generated input/output shapes fail typechecking. Effect itself is also a valid single-element Stream in Effect v3.

## Flow control and lifecycle

Every call gets a scope. Input uses pull-mode Node readables with bounded object-mode buffers; outgoing writes await the transport callback before pulling another message. The client response queue defaults to 16 messages. Bidi sending and receiving run independently through Effect's bounded stream merge; request completion half-closes the RPC and continues receiving. Cancelling a stream run or taking a prefix cancels the native call and interrupts its server handler. Input producer failure cancels its call and remains in the client error channel.

`makeServer` and `makeClient` require `Scope`. A channel is lazy and reusable for its scope. Acquire servers outside any actor/principal scope. Startup with an ambient correlation actor fails safely, so unrelated calls cannot inherit it. Server acquisition registers a Readiness check and a Shutdown finalizer. The application sets ready after startup. Shutdown stops admitting handler work, asks the transport to drain and waits up to `graceMs`, then force-closes transport sessions and interrupts remaining call fibers. Scope closure performs the same idempotent close. Set the coordinator finalizer budget above `graceMs`, and the process shutdown budget above all finalizers. Handler effects and finalizers must cooperate with interruption; an application that masks interruption indefinitely cannot be forcibly cleaned up in process.

Each RPC deadline is the smaller of the peer deadline and server `maxCallMs`. It covers verification, handler work and streaming. `context.remainingMs` recomputes the remaining time; CQRS forwards it as the bus timeout. Client timeouts cover the entire call, including established streams. Cancellation interrupts effects, stream producers/consumers and scoped finalizers, and removes callback listeners. Native stream error listeners survive until the terminal status so late cancellation errors cannot become unhandled exceptions.

## Metadata and application security

`Metadata` supports repeated text values and binary `Uint8Array` values under `-bin` keys. It copies binary values on construction/read. A handler receives `context.metadata`, `context.sendHeaders(metadata)` and `context.setTrailers(metadata)`. Send initial metadata once before the first response; automatic initial metadata is sent at the first response or failure. Clients inspect it through `onHeaders` and final status metadata through `onTrailers`. These synchronous observation callbacks should not throw.

The adapter propagates `x-correlation-id`, accepting only 1–64 characters in `[A-Za-z0-9_-]`, as HTTP does. It replaces unsafe inbound and ambient identifiers with new IDs and echoes the sanitized identifier in response headers. Actor metadata is never trusted.

```ts
makeServer([handlers], {
  address: "127.0.0.1:50051", security: { mode: "insecure" },
  verify: (request) => verifyCredential(request.metadata).pipe(
    Effect.map((principal) => ({
      actor: principal.id,
      within: Principal.within(principal),
    })),
  ),
});
```

`verifyCredential` and `Principal` belong to the application. Return `GrpcError` with `UNAUTHENTICATED` or `PERMISSION_DENIED` for rejection, or use the corresponding existing classified auth errors. `within` wraps the whole Effect/Stream run. Fiber context such as `Principal.within` reaches CQRS handlers; replacing an acquisition-time service does not replace services captured by a bus registry. No auth or authorization package is a grpc dependency. Omitting verification explicitly allows anonymous use; applications decide which listeners require authentication.

Select `{ mode: "insecure" }` explicitly for local listeners, or TLS:

```ts
security: {
  mode: "tls", certificate: certificateBytes,
  privateKey: Redacted.make(privateKeyBytes),
  ca: caBytes, requireClientCertificate: true, // server mutual TLS
}
// Client:
security: { mode: "tls", ca: caBytes, serverName: "api.example.com" }
```

Server certificate/private key are mandatory; client certificate/private key must be configured together. Server mutual TLS requires a CA. Certificate verification stays enabled. When a client connects to an IP address, provide the DNS `serverName` verified against the certificate; Bun rejects IP addresses in TLS SNI. Credentials and certificate rotation remain application startup concerns. Test PEM keys are public fixtures, never deployment material.

## Configuration

Options are immutable for a resource's lifetime and validated before binding/constructing it. Ordinary settings can come from `@structure-ai/config`; secret keys stay `Redacted` to the transport call site. All values below require restart to change.

| Option | Default | Bounds and purpose |
| --- | --- | --- |
| `address` | required | host:port; port 0 only for server ephemeral bind |
| `security` | required | explicitly `tls` or `insecure` |
| `maxReceiveBytes`, `maxSendBytes` | 4 MiB each | 1 byte–64 MiB; per protobuf message, including streaming |
| `bufferSize` | 16 | 1–65,536 messages; client response queue, separate from transport buffering |
| `timeoutMs` | 30,000 | client call default/override, 1 ms–24 hours, overall deadline |
| `maxCallMs` | 30,000 | server maximum RPC lifetime, 1 ms–24 hours |
| `maxActiveCalls` | 1,024 | server handler concurrency, 1–65,536; overload → RESOURCE_EXHAUSTED |
| `graceMs` | 1,000 | server drain, 0–60,000 ms |

Native HTTP/2 session memory is bounded separately at 8 MiB. A transport may refuse work when that session budget is reached, even below a configured per-message limit. Choose small message sizes and queue/concurrency budgets appropriate to application memory. Server channel diagnostics remain enabled because grpc-js's disabled-diagnostics teardown path reads an unbound Bun session socket.

## Errors and business failures

`GrpcError` contains only a numeric gRPC `code`, a fixed safe message, and `classification`. `GrpcConfigError` carries safe startup violations. Server mapping never forwards arbitrary messages, stack traces or objects. Framework contracts are schema-validated; a tag alone is insufficient. A single declared business failure takes precedence over framework mapping. Compound causes containing interruption map to CANCELLED; defects and other compound causes map to INTERNAL rather than hiding a defect behind a typed failure.

| Failure | Status | Classification |
| --- | --- | --- |
| shape/protobuf validation | INVALID_ARGUMENT (3) | permanent |
| missing/invalid identity | UNAUTHENTICATED (16) | permanent |
| permission, CQRS Unauthorized | PERMISSION_DENIED (7) | permanent |
| concurrency/idempotency mismatch | ABORTED (10) | conflict |
| deadline/bus timeout | DEADLINE_EXCEEDED (4) | transient |
| cancellation | CANCELLED (1) | permanent |
| service unavailable/idempotency in flight | UNAVAILABLE (14) | transient |
| message/concurrency budget | RESOURCE_EXHAUSTED (8) | transient |
| unexpected error or defect | INTERNAL (13) | permanent |
| declared business failure | FAILED_PRECONDITION (9) | application-owned typed failure |

Applications explicitly define a protobuf business-error message with stable field numbers and a codec for the encoded side of an Effect schema:

```ts
// Generated from: message Rejected { string reason = 1; }
const RejectedSchema = Schema.Struct({
  _tag: Schema.Literal("Rejected"), reason: Schema.String,
});
const rejected = businessFailure(RejectedSchema, {
  encode: (wire) => toBinary(RejectedProtoSchema,
    create(RejectedProtoSchema, { reason: wire.reason })),
  decode: (bytes) => ({ _tag: "Rejected" as const,
    reason: fromBinary(RejectedProtoSchema, bytes).reason }),
});
const failures = { unary: rejected };
const registration = service(Probe, handlers, { failures });
const client = yield* makeClient(Probe, { address, security, failures });
```

The schema validates before encoding and after decoding. Only the declared, encoded shape goes on the wire. Codecs must be pure and schemas should include a discriminant for failure unions. The wire contract uses terminal status `FAILED_PRECONDITION`, fixed status text `Business failure`, trailer `structure-failure-version: 1`, and protobuf bytes in `structure-failure-bin`. The payload limit is 8,192 bytes. Missing, wrong-version, oversized or invalid typed payloads fail as safe INTERNAL on a client configured with the contract; an unconfigured standard client sees ordinary FAILED_PRECONDITION. Oversized server failures become safe INTERNAL. The same terminal trailers preserve a failure after a stream has already emitted messages. The adapter drains messages already delivered to its readable/response buffers before failing, in order. grpc-js uses fail-fast non-OK status delivery and can discard native transport frames that it has not yet delivered to the readable. A failed RPC does not guarantee delivery of every server-produced message; applications needing acknowledgements or resume positions must put them in their protobuf contract. This is an explicit application contract, not `google.rpc.Status` rich errors or arbitrary JSON serialization.

## CQRS, retry ownership and telemetry

`GrpcCqrs.command(definition, { payload, response })` and `GrpcCqrs.query(...)` are unary handlers. Mappings translate generated protobuf input/output to existing bus schemas. The adapter forwards verified actor context, ambient sanitized correlation, text `x-idempotency-key`, and the remaining deadline. The bus owns validation, authorization, idempotency and business behavior. Configure `businessFailure(definition.failure, codec)` when exposing declared bus failures. Streaming handlers use Effect Stream directly.

There is no retry option. Transport retries, transparent retries and resolver service-config policies are disabled; each invocation makes one RPC. Applications own any explicit retry policy, bounded by one overall deadline. Replaying commands requires an explicit durable idempotency guarantee and stable identity/key. Do not automatically replay established streams.

The adapter records `grpc_server`/`grpc_client` calls, errors and duration metrics, `grpc.server`/`grpc.client` spans, and completion boundary logs at debug level. Labels are generated service names, registered method names and finite gRPC statuses. Correlation scopes attach safe IDs to logs/spans. Boundary span completion contains only a fixed status failure or an empty success, so exporters never receive arbitrary causes or successful messages. No bodies, credentials, arbitrary metadata, raw peer addresses or exception objects are logged. Transport-level failures before a handler starts are additionally visible through grpc-js diagnostics. Enable the framework logger/OTLP layer and debug level as needed; grpc-js's own verbose tracing is a development diagnostic and may include metadata.

## Verification

Tests use loopback listeners and local subprocess fixtures. Independent Connect peers use its native gRPC protocol, with Connect and gRPC-Web disabled on the peer server. Both directions cover all four RPC kinds. With Node 22+ installed, `GRPC_TEST_NODE=1 bun test test/interop.test.ts` hosts those independent peers on Node while Structure runs on Bun; the default uses only Bun. Typechecking covers generated requests/responses, declared failures and invalid handlers; tests cover ordering, independent bidi progress, backpressure, metadata, correlation, application verification, CQRS, deadlines, interruption, failure after stream emission, shutdown/drain, message limits, safe errors, and trusted/untrusted mutual TLS.

`bun test/fixtures/backpressure.mjs` is a standalone standard-transport feasibility reproduction. It should exit 0 and show a stable producer count while the readable buffer stays full. It fails on Bun 1.3.14 and passes on pinned Bun 1.4.1 and Bun 1.4.2. See [ADR-0021](../../docs/decisions/0021-native-grpc-effect-adapter.md).
