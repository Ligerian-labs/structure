import { Socket } from "node:net";
import { Deferred, Effect, Ref } from "effect";
import type { Scope } from "effect/Scope";
import { NisshiConnectionError } from "./errors.js";
import { Reader, Writer } from "./primitives.js";

/** Kafka API keys this client speaks. */
export const ApiKey = {
  produce: 0,
  fetch: 1,
  listOffsets: 2,
  metadata: 3,
  createTopics: 19,
  apiVersions: 18,
} as const;

/**
 * Protocol versions we pin — non-flexible framing, the simplest shape per
 * API. Verified against Nisshi v0.7.0-pre.2. Notably CreateTopics v0 wedges
 * the broker (missing assignments array); v4 is the safe choice.
 */
export const PinnedVersion = {
  produce: 3,
  fetch: 4,
  listOffsets: 1,
  metadata: 0,
  createTopics: 4,
  apiVersions: 0,
} as const;

/** A live, handshaked connection. Requests are serialized; responses match by correlation id. */
export interface NisshiConnection {
  /** API key → [minVersion, maxVersion] as reported by the broker. */
  readonly versions: ReadonlyMap<number, readonly [number, number]>;
  /** Sends one request, awaits its response body (correlation id stripped). */
  readonly request: (
    apiKey: number,
    apiVersion: number,
    build: (writer: Writer) => void,
    timeoutMillis: number,
  ) => Effect.Effect<Uint8Array, NisshiConnectionError>;
}

interface HostPort {
  readonly host: string;
  readonly port: number;
}

const parseUrl = (url: string): HostPort => {
  const parsed = new URL(url);
  const port = Number(parsed.port);
  if (parsed.protocol !== "tcp:" || !parsed.hostname || Number.isNaN(port)) {
    throw new Error(`nisshi: broker url must be tcp://host:port, got ${url}`);
  }
  return { host: parsed.hostname, port };
};

const assertVersion = (
  versions: ReadonlyMap<number, readonly [number, number]>,
  name: string,
  key: number,
  pinned: number,
): void => {
  const range = versions.get(key);
  if (range === undefined) {
    throw new NisshiConnectionError({ reason: `broker does not expose ${name} (api key ${key})` });
  }
  if (pinned < range[0] || pinned > range[1]) {
    throw new NisshiConnectionError({
      reason: `broker supports ${name} v${range[0]}-${range[1]}, client pins v${pinned}`,
    });
  }
};

/**
 * Connects to `brokerUrl`, handshakes with ApiVersions, verifies every
 * pinned version is offered, and returns the connection. The socket lives
 * for the surrounding scope.
 */
export const openConnection = (
  brokerUrl: string,
  clientId: string,
): Effect.Effect<NisshiConnection, NisshiConnectionError, Scope> =>
  Effect.gen(function* () {
    const { host, port } = yield* Effect.sync(() => parseUrl(brokerUrl)).pipe(
      Effect.mapError(
        (cause) => new NisshiConnectionError({ reason: `invalid broker url ${brokerUrl}`, cause }),
      ),
    );

    const socket: Socket = yield* Effect.acquireRelease(
      Effect.async<Socket, NisshiConnectionError>((resume, signal) => {
        const s = new Socket();
        const onAbort = () => s.destroy();
        signal.addEventListener("abort", onAbort, { once: true });
        s.once("connect", () => {
          signal.removeEventListener("abort", onAbort);
          resume(Effect.succeed(s));
        });
        s.once("error", (err) => {
          signal.removeEventListener("abort", onAbort);
          resume(Effect.fail(new NisshiConnectionError({ reason: "connect failed", cause: err })));
        });
        s.connect(port, host);
      }),
      (s) => Effect.sync(() => s.destroy()),
    );

    const pending = yield* Ref.make<
      Map<number, Deferred.Deferred<Uint8Array, NisshiConnectionError>>
    >(new Map());
    let correlation = 0;

    // Responses may split across TCP chunks; buffer until whole frames.
    let receive = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      receive = Buffer.concat([receive, chunk]);
      for (;;) {
        if (receive.length < 4) {
          return;
        }
        const size = receive.readInt32BE(0);
        if (size < 4 || receive.length < 4 + size) {
          return;
        }
        const body = new Uint8Array(receive.subarray(4, 4 + size));
        receive = receive.subarray(4 + size);
        const corr =
          body.length >= 4 ? new DataView(body.buffer, body.byteOffset, 4).getInt32(0) : -1;
        if (corr >= 0) {
          takePending(pending, corr, (deferred) => {
            Effect.runFork(Deferred.succeed(deferred, body.subarray(4)));
          });
        }
      }
    });
    socket.on("close", () => failAll(pending, "connection closed"));
    socket.on("error", (err) => failAll(pending, String(err)));

    const request = (
      apiKey: number,
      apiVersion: number,
      build: (writer: Writer) => void,
      timeoutMillis: number,
    ): Effect.Effect<Uint8Array, NisshiConnectionError> =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<Uint8Array, NisshiConnectionError>();
        correlation += 1;
        const corr = correlation;
        yield* Ref.update(pending, (map) => new Map(map).set(corr, deferred));

        const writer = new Writer().i16(apiKey).i16(apiVersion).i32(corr).str(clientId);
        build(writer);
        const payload = writer.out();
        // `false` only signals backpressure (data is still queued); real
        // failures surface through the close/error handlers.
        connection_socket_write(socket, payload);

        return yield* Deferred.await(deferred).pipe(
          Effect.timeoutFail({
            duration: timeoutMillis,
            onTimeout: () =>
              new NisshiConnectionError({
                reason: `request timed out (api ${apiKey} v${apiVersion})`,
              }),
          }),
          Effect.ensuring(Effect.sync(() => takePending(pending, corr, () => {}))),
        );
      });

    // Handshake: ApiVersions v0, then verify every pinned version is offered.
    const body = yield* request(ApiKey.apiVersions, PinnedVersion.apiVersions, () => {}, 5000);
    const reader = new Reader(body);
    const errorCode = reader.i16();
    if (errorCode !== 0) {
      return yield* Effect.fail(
        new NisshiConnectionError({ reason: `ApiVersions rejected with code ${errorCode}` }),
      );
    }
    const count = reader.i32();
    const versions = new Map<number, readonly [number, number]>();
    for (let i = 0; i < count; i++) {
      versions.set(reader.i16(), [reader.i16(), reader.i16()]);
    }
    assertVersion(versions, "Produce", ApiKey.produce, PinnedVersion.produce);
    assertVersion(versions, "Fetch", ApiKey.fetch, PinnedVersion.fetch);
    assertVersion(versions, "Metadata", ApiKey.metadata, PinnedVersion.metadata);
    assertVersion(versions, "CreateTopics", ApiKey.createTopics, PinnedVersion.createTopics);
    assertVersion(versions, "ListOffsets", ApiKey.listOffsets, PinnedVersion.listOffsets);

    return { versions, request };
  });

// --- helpers running on the socket thread (outside Effect) ---
type PendingMap = Ref.Ref<Map<number, Deferred.Deferred<Uint8Array, NisshiConnectionError>>>;

function connection_socket_write(socket: Socket, payload: Uint8Array): void {
  socket.write(new Writer().i32(payload.length).raw(payload).out());
}

const takePending = (
  pending: PendingMap,
  corr: number,
  use: (deferred: Deferred.Deferred<Uint8Array, NisshiConnectionError>) => void,
): void => {
  let found: Deferred.Deferred<Uint8Array, NisshiConnectionError> | undefined;
  Effect.runSync(
    Ref.modify(pending, (map) => {
      found = map.get(corr);
      const next = new Map(map);
      next.delete(corr);
      return [found, next];
    }),
  );
  if (found !== undefined) {
    use(found);
  }
};

const failAll = (pending: PendingMap, reason: string): void => {
  const all = Effect.runSync(Ref.getAndSet(pending, new Map()));
  for (const deferred of all.values()) {
    Effect.runFork(Deferred.fail(deferred, new NisshiConnectionError({ reason })));
  }
};
