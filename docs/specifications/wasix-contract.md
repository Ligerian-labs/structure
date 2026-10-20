# WASIX artifact and guest/host contract

Status: proposed specification, contract revision 1. No package, runner or host described here exists in Structure yet. Normative words MUST, MUST NOT and SHOULD describe implementation requirements, not tested functionality. The [SDK specification](serverless.md) and [hosting specification](structure-infra.md) consume this contract. This document owns shared fields, limits, protocol and lifecycle; hosts MUST NOT silently substitute another transport. The host link is provisional until the companion specification lands.

## Execution target and trust boundary

Revision 1 targets a WebAssembly **core command module** with `_start`, a pinned WASI preview1/WASIX import allowlist, an embedded QuickJS engine and a bundled ESM application. It uses private stdin/stdout pipes for `structure:stdio/1`. JavaScript executes inside guest linear memory. A recommended native Wasmer worker runs each instance in a separate supervised OS process. Building this runner and proving its import/Effect compatibility are blocking implementation spikes.

These are distinct contracts:

| Target | Meaning | Revision 1 position |
| --- | --- | --- |
| WASIX process ABI | WASI preview1 plus WASIX syscalls; an engine can execute a command | Required, with capabilities denied unless this contract grants them |
| Embedded JavaScript | QuickJS compiled into the guest; Web APIs and the event loop need bindings | Recommended guest profile, subject to proof gates |
| Host-JavaScript imports | A module imports `napi` / `napi_extension_wasmer_v0` and executes JS in a host engine | Rejected in this profile, including arbitrary host loaders |
| WASI HTTP component | A component exports `wasi:http/proxy`, with typed incoming/outgoing HTTP interfaces | A separate future target; `wasmtime serve` cannot stand in for this runner |

WASIX availability does not provide Fetch, Node APIs, Bun APIs, Effect services, filesystem permissions or tenant authorization. The SDK shim must implement its documented JavaScript subset; the host must independently enforce resource and authority limits against malicious guest code. A guest can forge every stdout message. Neither an honest SDK nor manifest declarations are a security boundary.

Primary evidence checked 2026-10-20:

- [Wasmer WASIX documentation](https://docs.wasmer.io/runtime/wasix/) describes process/syscall extensions and runtime packages. It does not establish Structure compatibility.
- [Edge.js root README](https://github.com/wasmerio/edgejs/blob/18b0ce9ef6484feb796445567787a113a682a9d5/README.md#host-javascript-wasix-package) distinguishes host-engine imports from its separate [embedded QuickJS package](https://github.com/wasmerio/edgejs/tree/18b0ce9ef6484feb796445567787a113a682a9d5/quickjs-wasm). The latter documents a Wasmer 7.4.2 / 4 MiB host-stack starting point, not a supported Structure runtime tuple.
- [Edge.js host-JS security notes](https://github.com/wasmerio/edgejs/blob/18b0ce9ef6484feb796445567787a113a682a9d5/SECURITY-HOST-JS-NAPI.md) list ambient-authority and resource-control work. That mode is excluded rather than assumed sandboxed.
- [QuickJS C API](https://bellard.org/quickjs/quickjs.html#QuickJS-C-API) provides engine memory and interrupt controls. Wiring and testing them in WASIX remains work.
- [Wasmtime CLI](https://docs.wasmtime.dev/cli-options.html#serve) describes its different WASI HTTP component contract and warns that the development server needs additional production controls.

No upstream compatibility or performance assertion in those sources is an acceptance result for this design. Host technology selection and its alternatives are detailed in the hosting specification.

## Artifact format

An artifact is an immutable directory or an archive of exactly that directory:

```text
structure.json
runner.wasm
app.mjs
```

`structure.json` is UTF-8 JSON without BOM, duplicate keys, unknown fields, nonfinite values or unsafe integers. Maximum manifest size is 64 KiB. Paths are relative POSIX paths, without empty, dot or dot-dot segments, backslashes, NUL, absolute paths, symlinks, hardlinks or device entries. Revision 1 allows only the three regular files above. Each file is at most 64 MiB and the unpacked directory at most 128 MiB. An archive has the same compressed-size ceiling and a bounded extractor; compression bombs and additional entries are rejected before publication. Source maps and assets require a later explicit format extension.

The following is a **proposed illustrative artifact**, with synthetic hashes and sizes. It is not a runnable or checksum-valid fixture. All fields shown are required, including empty arrays; their types are defined below.

```json
{
  "schemaVersion": 1,
  "abi": "structure:wasix/1",
  "protocol": "structure:stdio/1",
  "executionProfile": "quickjs-wasix-stdio/1",
  "appId": "catalog-api",
  "module": "runner.wasm",
  "entrypoint": "app.mjs",
  "files": [
    { "path": "app.mjs", "sizeBytes": 12000, "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    { "path": "runner.wasm", "sizeBytes": 4000000, "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
  ],
  "runtime": {
    "engine": "quickjs",
    "engineVersion": "2026-06-04",
    "runnerBuild": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "toolchain": "wasix-toolchain@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
  },
  "requirements": {
    "configKeys": ["CATALOG_URL"],
    "secretKeys": ["CATALOG_TOKEN"],
    "capabilities": [
      { "kind": "https", "name": "catalog", "origins": ["https://catalog.example.com"] }
    ],
    "limits": {
      "memoryBytes": 134217728,
      "workerRssBytes": 268435456,
      "startupMs": 10000,
      "requestMs": 30000,
      "cancelGraceMs": 100,
      "drainMs": 5000,
      "idleMs": 60000,
      "bodyBytes": 1048576,
      "headerBytes": 16384,
      "headerCount": 64,
      "frameBytes": 2097152,
      "activeRequests": 1,
      "activeCalls": 4,
      "callsPerRequest": 32,
      "logBytesPerSecond": 16384
    }
  },
  "provenance": {
    "sourceRevision": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    "lockSha256": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    "builderId": "structure-serverless-builder/1"
  }
}
```

| Field | Validation / semantics |
| --- | --- |
| `schemaVersion`, `abi`, `protocol`, `executionProfile` | Exact literals above; no semver ranges or negotiation downgrade |
| `appId` | `[a-z][a-z0-9-]{0,62}`; must match authenticated deployment binding; never identifies a tenant by itself |
| `module`, `entrypoint` | Exact filenames above; runner reads `/artifact/app.mjs` from a read-only verified mount |
| `files` | Exactly two entries sorted by `path`, no duplicates; nonnegative safe-integer byte size and lowercase 64-hex SHA-256 of exact bytes; excludes manifest to avoid self-reference |
| `runtime` | Literal engine, exact engine version, 64-hex runner source/build identity, toolchain identity string up to 256 bytes; host admits only explicitly approved tuples and actual Wasm imports |
| `configKeys`, `secretKeys` | Unique sorted `[A-Z][A-Z0-9_]{0,63}` keys, disjoint sets, maximum 64 total keys; no values in artifact |
| `capabilities` | Up to 16 unique names matching `appId` syntax; only `kind: "https"`; each has 1–16 canonical HTTPS origins, no wildcard, path, credentials, query or fragment |
| `limits` | Positive safe integers, bounded by the table below; `activeRequests` exactly 1; guest-requested maxima, never grants |
| `provenance` | Full source commit ID, lock digest and builder identity up to 128 ASCII bytes; authorization and signatures remain host policy |

`artifactDigest` is `sha256:` followed by SHA-256 of the **exact uploaded manifest bytes**, including whitespace. Verified file digests make those bytes an address for the complete artifact. Never parse/reserialize before computing the address. Publication is atomic only after all file sizes/digests and imports pass; reads by digest must return those same immutable bytes. Tags and deployment names are mutable pointers, never cache identities. Signing/attestation binds this digest to an approved builder; a digest alone does not establish trust. Hosts never deserialize tenant-supplied native compiled caches; any AOT cache is host-generated and keyed by artifact, engine/compiler version, target architecture and policy.

No packages, engine code or ESM imports may be fetched at boot. `app.mjs` is a closed bundle with no unresolved imports, dynamic code loading, native addons or external bytecode. Bytecode is version-specific and must not be accepted from untrusted uploaders. A verified runner is allowlisted independently of an application's provenance.

## Deployment binding and authorization

The control plane owns a separate authenticated binding. This is **proposed shape**, not an unauthenticated guest request:

```ts
interface DeploymentBinding {
  readonly tenantId: string;
  readonly appId: string;
  readonly environmentId: string;
  readonly revisionId: string;
  readonly artifactDigest: string;
  readonly configRevision: string;
  readonly policyRevision: string;
  readonly config: Readonly<Record<string, string>>;
  readonly secretRefs: Readonly<Record<string, string>>;
}
```

IDs are opaque host-issued ASCII identifiers of 1–128 bytes. The caller must authenticate and be authorized for the exact tenant, application, environment, artifact and requested action. Host routes derive tenant and revision from this stored binding, never a client `x-tenant-id` header or a guest frame. Every artifact/config/secret lookup and instance cache key is scoped to it. App users still authenticate in application code; a deployment tenant is not an application principal or an authorization-policy role.

Secret references identify pinned secret versions accessible only to that binding. The control plane rejects missing secret references, undeclared keys and cross-tenant references. Nonsecret config may omit declared keys to use code defaults; the guest validates required keys and types before readiness. Guest config loads only declared keys; no worker shell environment is inherited. Config precedence is safe code defaults then host-validated versioned nonsecret values; the deployment process has already resolved allowed overrides. Secrets use the separate map and become `Redacted` at the SDK boundary. Combined config and secret value UTF-8 size is at most 32 KiB; values cannot enter argv, artifact, telemetry or errors. Init pipes and process memory are private, never persisted or transcript-logged. Guest code authorized for a secret can read or exfiltrate it within its granted capabilities; redaction is not protection from its author.

Rotation creates a new `configRevision` and new instances. Policy revocation immediately disables affected calls and dispatch, then drains/kills old instances. Ordinary config rollouts drain old instances after replacement readiness; secrets requiring urgent revocation use the policy-revocation path. A failed replacement must not re-enable a revoked grant. Environment promotion reuses the same artifact digest with a new binding. Rollback restores an approved artifact/binding pair only if current policy and data schema still permit it.

## Resource and capability enforcement

These numbers are proposed MVP ceilings and acceptance bounds, not measured performance. Host policy may lower a requested ceiling and sends the effective values in `init`; it must reject a workload if the lowered values cannot be supplied safely. Guests must validate effective values before readiness. Limits are per instance/request unless marked otherwise.

| Limit | Revision 1 ceiling / required behavior |
| --- | --- |
| Wasm linear memory | `memoryBytes = 134217728`, enforced on initial allocation and growth |
| Worker RSS | `workerRssBytes = 268435456`, including native engine/compiler/pipe buffers; OS supervisor kills on breach |
| Startup | `startupMs = 10000`, starts at worker spawn; includes init, config and required readiness checks |
| Request | `requestMs = 30000`, total at ingress including body receipt, queue and cold start; host monotonic clock owns it |
| Cancellation | `cancelGraceMs = 100`, then terminate instance if the invocation has not completed cleanup |
| Drain | `drainMs = 5000`, then revoke calls and terminate; no promise of completing longer requests |
| Idle | `idleMs = 60000`, begins after terminal request cleanup, scale to zero through drain |
| Body | `bodyBytes = 1048576`, decoded bytes in each ingress, response, egress request and egress response, before allocating full body |
| Headers | `headerBytes = 16384` UTF-8 name/value bytes in total and `headerCount = 64`, per header list |
| Frame | `frameBytes = 2097152`, UTF-8 bytes excluding newline, bounded incremental parser |
| Invocation concurrency | `activeRequests = 1`; no multiplexed requests within an instance |
| Egress | `activeCalls = 4`, `callsPerRequest = 32`; no startup or idle calls |
| Logs | `logBytesPerSecond = 16384`, 4 KiB/record, bounded host collection, overflow dropped and counted |
| Host admission | Per deployment queue 32 requests, wait at most 1000 ms; deployment max instances default 10 and tenant aggregate quotas enforced before allocation |
| CPU / hard preemption | One worker thread, host quota at most one CPU; external monotonic deadline and process termination must work during a JS/Wasm busy loop or host call |

The host must cap compilation concurrency, uploaded and compiled code, buffered bytes, live pipes, timer count and native stack as well as guest memory. Initial profile budgets are 128 timers/instance and 4 MiB native stack. A native stack limit is not part of Wasm memory. No unbounded host queue may sit behind a bounded guest queue. Limits cannot rely only on cooperative Effect interruption or QuickJS callbacks; if hard enforcement cannot be proved, tenant execution stays disabled.

Filesystem access is only read-only `/artifact` plus private ephemeral `/tmp`, quota 8 MiB, cleared at exit. Preopen nothing else. No inherited env, directories, descriptors or credentials. Raw sockets, DNS syscalls, listening sockets, fork/exec, process spawning and shared-memory threads are denied at host imports/policy even if the compiled runtime knows those syscalls. Time, entropy, bounded timers and stdio are explicitly permitted by the approved runner import profile. This profile requires no custom host-JS/N-API imports; SDK-to-host capabilities travel in frames.

`https.fetch` is the only revision 1 remote capability. A grant is an opaque name bound to allowed origins and the tenant/deployment policy, not a bearer credential transferable to another instance. Every call must reference an active request. The host validates the name, method, URL and byte/time budgets again, resolves DNS itself, pins the approved public destination through connection establishment, verifies TLS and rejects loopback, private, link-local, multicast, metadata endpoints and IP literals. Canonicalize IDNA/hostnames and reject userinfo/ambiguous encodings. Redirects are returned as 3xx without following; guest following requires a new authorized call. No network proxy, alternate resolver, `CONNECT`, arbitrary scheme or raw headers can bypass this check. Named private service access requires a future explicit policy, not a broad network grant. No automatic egress retries occur. Host credentials for its control plane are never exposed to the guest.

## Wire protocol

`structure:stdio/1` is newline-delimited strict UTF-8 JSON, one complete object per line, `\n` delimiter, no BOM, blank lines, duplicate keys or unknown fields. Embedded newlines are JSON escaped. Do not accept a partially received or oversized line. EOF, invalid JSON, unknown message type/version, out-of-order frame, duplicate terminal frame or impossible ID is `ProtocolViolation`, closes pipes and terminates the instance. Each side bounds queued frames to eight and total queued bytes to 4 MiB. Backpressure must pause readers/writers; if the owning operation deadline expires, cancel it rather than buffer further. stderr is never parsed as protocol. Console output uses the bounded sanitized stderr sink; tenant stderr is untrusted data.

Every frame has `v: 1` and `type`. All objects below are closed schemas. Instance, request, call and correlation IDs match `[A-Za-z0-9_-]{1,64}`; request and call IDs are unique for the instance lifetime. Config revision identifiers retain the deployment binding's 1–128 ASCII-byte rule. JSON body bytes use canonical padded RFC 4648 base64, `""` for empty. Never encode a body as a Unicode string. No frame has a stack, arbitrary exception, secret value outside `init.secrets`, or raw Effect Cause.

Common proposed wire types:

```ts
type Headers = ReadonlyArray<readonly [string, string]>;
interface HttpRequestData {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly bodyBase64: string;
}
interface HttpResponseData {
  readonly status: number;
  readonly headers: Headers;
  readonly bodyBase64: string;
}
type FailureCode =
  | "InvalidConfig" | "UnsupportedRuntime" | "CapabilityDenied"
  | "DeadlineExceeded" | "Cancelled" | "BodyTooLarge"
  | "DependencyUnavailable" | "Internal";
interface SafeFailure {
  readonly code: FailureCode;
  readonly classification: "transient" | "permanent" | "conflict";
}
```

`Headers` preserves repeated values and ordering, including separate `set-cookie` entries. Header names are lowercase valid HTTP tokens; values contain no CR/LF/NUL. Methods are uppercase tokens, at most 32 bytes. URLs are absolute HTTPS URLs at most 8192 bytes, derived from the host's canonical route origin for ingress. Request URL path/query and body are application data, not routing authority. Response status is 200–599 except 101; informational responses and trailers are unsupported. HEAD, 204 and 304 responses have empty bodies. Both sides enforce these conditions.

| Direction / type | Required fields besides `v`, `type` | Meaning |
| --- | --- | --- |
| G→H `hello` | `abi`, `protocol`, `executionProfile`, `artifactDigest` | Exact literals and address supplied by trusted runner bootstrap; host independently checks them |
| H→G `init` | `instanceId`, `configRevision`, `config`, `secrets`, `grants`, `limits` | `config`/`secrets` are string maps; grants use manifest capability shape with effective origin subsets; limits has exactly the manifest limit keys |
| G→H `ready` | `instanceId` | Config validation, resource acquisition, handler build and required readiness checks succeeded |
| G→H `startupError` | `error` | SafeFailure, no config values; terminal for instance |
| H→G `request` | `requestId`, `timeoutMs`, `correlationId`, `http` | Timeout is positive remaining ingress budget; `http` is HttpRequestData |
| G→H `response` | `requestId`, `http` | HttpResponseData, terminal after request-owned cleanup |
| G→H `requestError` | `requestId`, `error` | SafeFailure, terminal after request-owned cleanup |
| H→G `cancel` | `requestId`, `reason` | Reason `deadline`, `disconnect` or `shutdown`; revoke egress immediately |
| G→H `call` | `requestId`, `callId`, `grant`, `operation`, `timeoutMs`, `http` | Operation exactly `https.fetch`; HttpRequestData, timeout positive and within invocation budget |
| H→G `callResult` | `requestId`, `callId`, `result` | Exactly `{ "ok": true, "http": HttpResponseData }` or `{ "ok": false, "error": SafeFailure }` |
| H→G `drain` | `timeoutMs`, `reason` | Reason `idle`, `rollout`, `shutdown` or `policy`; timeout at most effective drainMs |
| G→H `drained` | `instanceId` | No active invocation/call/timer; instance finalizers completed; runner then exits 0 |

`grants` is an array, configuration maps and limits use artifact schemas, correlation IDs use the ID syntax above. The runner receives artifact identity and read-only paths from the supervisor's verified bootstrap, never resolves a mutable registry tag. `init` intentionally does not transmit tenant administration credentials or authorize application users.

Failures have fixed classifications: `DependencyUnavailable` and `DeadlineExceeded` are transient; all other listed codes are permanent. Conflict is reserved for future codes and is not emitted for revision 1 protocol failures. Typed application conflicts remain ordinary HTTP 409 responses. Unknown codes or mismatched classifications are protocol violations. No arbitrary messages cross this error channel. Host logs only a stable code, bounded safe IDs and its own failure context.

Example **proposed frame trace**, bodies simplified but schema intact:

```json
{"v":1,"type":"hello","abi":"structure:wasix/1","protocol":"structure:stdio/1","executionProfile":"quickjs-wasix-stdio/1","artifactDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
```

After a validated `init` with the full maps, grants and limits above:

```json
{"v":1,"type":"ready","instanceId":"i_01"}
{"v":1,"type":"request","requestId":"r_01","timeoutMs":29000,"correlationId":"c_01","http":{"method":"GET","url":"https://api.example.com/items","headers":[],"bodyBase64":""}}
{"v":1,"type":"call","requestId":"r_01","callId":"o_01","grant":"catalog","operation":"https.fetch","timeoutMs":5000,"http":{"method":"GET","url":"https://catalog.example.com/items","headers":[],"bodyBase64":""}}
{"v":1,"type":"callResult","requestId":"r_01","callId":"o_01","result":{"ok":true,"http":{"status":200,"headers":[["content-type","application/json"]],"bodyBase64":"W10="}}}
{"v":1,"type":"response","requestId":"r_01","http":{"status":200,"headers":[["content-type","application/json"]],"bodyBase64":"W10="}}
{"v":1,"type":"drain","timeoutMs":5000,"reason":"idle"}
{"v":1,"type":"drained","instanceId":"i_01"}
```

Host and guest use separate monotonically decreasing timeout budgets; the host's monotonic ingress deadline is authoritative. There is no wall-clock timestamp synchronization requirement. A malicious guest cannot extend a budget by sending a larger `timeoutMs`.

## Lifecycle, cancellation and HTTP outcomes

Allowed host-observed states are `Allocated → Starting → Ready → Busy → Ready`, with `Starting → Failed` and any live state `→ Draining → Stopped`. A crash or hard limit sends any live state to `Failed`; no failed instance is reused. `hello` occurs once, then `init` once, then `ready` or `startupError` once. A second request before the first terminal frame is invalid. `drain` may occur while Starting, Ready or Busy; it forbids new requests, permits the current request only within the smaller remaining request/drain budget, and closes instance resources before `drained`. A terminal request frame during drain leaves the instance Draining. During Starting it cancels initialization; `ready` must not follow a processed drain. Before hello/init completes, the host terminates an instance directly rather than sending a frame that requires initialization.

Readiness is not process existence. Host routing starts only after the admitted instance's `ready`. App required-resource readiness failure during operation must fail affected requests and retire the instance through drain; revision 1 has no unsolicited readiness-change frame. Liveness is supervisor progress/deadline enforcement, not a database ping. Starting a replacement does not mutate a previous immutable instance.

Warm reuse is only within `(tenantId, appId, environmentId, revisionId, artifactDigest, configRevision, policyRevision)`. A tenant boundary here is deployment isolation; an app serving several business tenants must enforce its own authorization and data filters for each request. Guest globals may cache bounded disposable data but must never carry a previous user's principal, authorization decision, transaction or request scope into another invocation. Avoid retaining sensitive request data beyond its scope. New instances have no durable local state.

Ingress terminates TLS, validates HTTP framing and enforces deadlines/body/header limits before creating a request frame. Remove hop-by-hop headers and fields named by `connection`; reject ambiguous Content-Length/Transfer-Encoding framing. GET/HEAD with a nonempty body is rejected with 400 before dispatch because the Web Request interface cannot represent it. The gateway strips client-provided forwarding and host-control headers, constructs the canonical URL and sanitized client metadata, and generates a safe correlation ID. Application Authorization/Cookie headers remain application inputs and must not enter telemetry. The guest response cannot set platform routing or tenant-control fields; gateway owns final framing and content-length. No automatic decompression is done by the bridge; apps which decompress must enforce a decoded-size bound. Streamed bodies must be collected within bodyBytes and deadline, never unbounded.

| Condition | Host-visible HTTP result / instance action |
| --- | --- |
| Guest returns a valid ordinary response | Preserve status/body/allowed headers, including schema-declared business 422; release only after cleanup |
| Malformed ingress / too many headers | 400 / 431 before dispatch |
| Oversized ingress body | 413 before dispatch, no guest side effect |
| Queue/tenant admission exhausted | 503 with `Retry-After: 1` before dispatch; rate policy may return 429 |
| Artifact/config/capability admission failure | Deployment rejected; no route; active old revision only if policy still permits |
| Cold start failure/crash before dispatch | 503; bounded replacement attempts charged to admission budget |
| Deadline before or after dispatch | 504 if client connected; send cancel when dispatched, hard-stop if necessary |
| Guest trap, malformed response or protocol failure after dispatch | 502 with safe correlation ID, retire instance, outcome may be unknown |
| `requestError` Internal / BodyTooLarge | 500 safe problem / 502 invalid-upstream-response problem; retire on malformed behavior |
| `requestError` DependencyUnavailable / CapabilityDenied | 503 / 403 safe problem; do not retry inside host |
| Client disconnect | Cancel, no response possible; record internal cancellation reason, not a fabricated wire status |
| Planned drain expires | Cancel active request; 503 if connected and no response committed; hard-stop |

`requestError DeadlineExceeded` maps to 504. `Cancelled` maps to the initiating host reason, 504 for deadline, 503 for shutdown, no response for disconnect. `InvalidConfig`/`UnsupportedRuntime` in a request are lifecycle violations and retire the instance with 502. Gateway-generated errors use JSON `{ "error": "<stable-code>", "correlationId": "<safe-id>" }`, never upstream content or secrets. A framework/app error already mapped to HTTP remains `response`, not `requestError`.

Client disconnect, request timeout and drain cancellation immediately stop new calls and abort outstanding host HTTP operations. The SDK interrupts the invocation's Effect scope and closes request-owned resources, then emits a terminal requestError within cancelGraceMs. If guest CPU, Promise microtasks, C code or finalizers do not cooperate, the external supervisor kills the worker. No terminal acknowledgment means no reuse. Late response/callResult frames for a cancelled operation are discarded during termination; they do not restore authority. For a response/cancel race, host cancellation wins once observed; any completed upstream write remains possible. The host records whether dispatch occurred and never retries a dispatched request automatically.

Cancellation is not rollback. A guest or egress connection can fail after an external command committed. Expose an unknown outcome to callers and reconcile through a durable operation/idempotency key. The client owns retries with the same durable key where the business service supports it. Generic 5xx and transient classification alone do not authorize replaying writes. Effect typed failures, defects, interruption and compound causes must retain their semantics up to HTTP mapping; an interruption is not success, and a defect is never encoded as a business failure.

Revision 1 does not provide streaming, SSE, WebSockets, gRPC, upgrade, HTTP trailers, multipart streaming or post-response `waitUntil`. A returned ReadableStream is collected within bounds before emitting a response. Background fibers/timers started for a request must finish or be interrupted and joined before its terminal frame. An app cannot hold the instance alive for an untracked side effect. Runtime code that cannot obey these bounds is rejected rather than silently truncated.

## Compatibility and promotion gates

Admission is an exact allowlist check across `(schemaVersion, abi, protocol, executionProfile, engineVersion, runnerBuild, toolchain, actual imports)` plus the host engine/compiler/platform tuple. A published support record must include those values, artifact digest, SDK/Effect/platform dependency versions, CPU architecture, exercised tests and evidence. Unknown tuples, imports or fields fail before `_start`. WASIX namespace spellings and individual imports are taken from the pinned compiled module and runner allowlist, never inferred from the name WASIX.

All rows below are **future unexecuted acceptance scenarios**. They define the SDK and host conformance suite. Passing TypeScript tests on Bun or reviewing this document does not pass a row.

| ID | Fixture / action | Required observable result |
| --- | --- | --- |
| C01 | Alter one app byte; use old manifest; then upload traversal/symlink/extra-file/compression bomb | Reject before publish/instantiate; bounded memory and no path escape |
| C02 | Unsupported version, import namespace, N-API import or component instead of core command | Deterministic UnsupportedRuntime, no fallback or route |
| C03 | Supply another tenant's artifact/config/secret ref; forge tenant headers, grant name and frame IDs | Deny each access; correct tenant and sibling instance remain unaffected |
| C04 | Missing/extra/malformed config, secret load failure and readiness timeout | Safe startupError, unready, no secret in logs/body/argv, existing permitted revision serves |
| C05 | Cold request at zero instances; wait 60 s idle; send again | Start once per allocation, route only after ready, drain to zero, same artifact/new instance |
| C06 | Binary body, repeated set-cookie, HEAD/204/304, invalid framing, body at limit and limit+1 | Exact bytes/headers where valid; appropriate empty bodies; bounded 400/413/431/502 failures |
| C07 | Handler success, declared business failure, conflict, defect, interrupted/compound Cause | Same app status/schema as existing HTTP semantics; safe defect and cancellation paths |
| C08 | Disconnect or deadline during Effect.sleep, host fetch, busy JS loop and infinite microtasks | Scope/call revoked; no new call; cleanup within 100 ms or process killed; next tenant serves |
| C09 | Guest writes unknown/oversized/partial/duplicate/out-of-order frames | Incremental bounded rejection, instance retired, dispatched mutation never replayed |
| C10 | Egress to public grant, wrong origin, DNS rebinding, redirect to metadata/private IP and TLS failure | Only approved public TLS call succeeds; every bypass denied and bounded |
| C11 | Memory.grow, engine heap/native allocation, timer/log/fetch floods and compiler storm | All budgets enforced outside guest, dropped telemetry counted, host/other tenant responsive |
| C12 | Kill after external write commits, before guest response; retry with same business key | Unknown original outcome, no host replay; durable backend deduplicates or reports status |
| C13 | Drain while busy/startup; deployment replacement/rollback; secret and policy revocation | No dispatch after drain, bounded cleanup/kill, no stale grant or cross-revision reuse |
| C14 | Old/new host and guest tuples during rollout; downgrade attempt | Only explicitly approved matching tuples; existing compatible instances continue or safely drain |
| C15 | Supported sample Effect app from SDK spec with host network/filesystem/env denied | Runs only with declared bindings and exact shim graph; unsupported API fails build/admission |

Before accepting third-party tenants, C01–C15 plus an external isolation review must pass on every supported host architecture. The first embedded-engine spike must pin exact source/dependency/compiler revisions and return import inventory, bundle graph, timers/Promise/encoding/Fetch/Abort tests, cold/warm timings with variability, RSS/linear-memory/stack measurements and busy-loop kill evidence. Failure blocks that profile; it does not justify selecting experimental host-JS under the same profile string. New transport, runtime mode or streaming semantics needs a new profile/protocol revision and a migration plan.
