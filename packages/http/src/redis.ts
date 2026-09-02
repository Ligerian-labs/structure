import * as net from "node:net";
import { Data, Effect } from "effect";

/** A Redis command failed (protocol error, connection failure, Redis error). */
export class RedisError extends Data.TaggedError("RedisError")<{
  readonly reason: string;
  readonly cause?: unknown;
}> {
  readonly classification: "transient" = "transient";
  override get message(): string {
    return `redis: ${this.reason}`;
  }
}

export interface RedisClient {
  /** Runs `EVAL script numkeys keys... args...` and returns the decoded reply. */
  readonly eval: (
    script: string,
    keys: ReadonlyArray<string>,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<unknown, RedisError>;
  readonly close: () => void;
}

interface Waiter {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: RedisError) => void;
}

interface Reply {
  readonly value: unknown;
  readonly rest: string;
}

const encodeCommand = (parts: ReadonlyArray<string>): string =>
  `*${parts.length}\r\n${parts
    .map((part) => `$${Buffer.byteLength(part, "utf8")}\r\n${part}\r\n`)
    .join("")}`;

/**
 * A minimal RESP2 client over a single persistent TCP connection with no
 * external dependency. Commands serialize through one promise chain (Redis
 * replies in request order), replies decode from `+`, `-`, `:`, `$` and `*`
 * frames. Supports `redis://:password@host:port/db` URLs (AUTH + SELECT).
 * Connection loss fails all in-flight commands transiently; the next command
 * reconnects.
 */
export const makeRedisClient = (options: {
  readonly url: string;
  readonly connectTimeoutMillis?: number;
}): RedisClient => {
  const url = new URL(options.url);
  const host = url.hostname || "127.0.0.1";
  const port = Number(url.port || 6379);
  const password = url.password || undefined;
  const username = url.username || undefined;
  const dbNumber = url.pathname.length > 1 ? url.pathname.slice(1) : undefined;
  const connectTimeout = options.connectTimeoutMillis ?? 5_000;

  let socket: net.Socket | undefined;
  let buffer = "";
  let pending: Array<Waiter> = [];
  let chain: Promise<unknown> = Promise.resolve();
  let closed = false;

  const failPending = (error: RedisError): void => {
    const waiting = pending;
    pending = [];
    for (const waiter of waiting) waiter.reject(error);
  };

  const parseReply = (input: string): Reply | undefined => {
    const lineEnd = input.indexOf("\r\n");
    if (lineEnd < 0) return undefined;
    const line = input.slice(0, lineEnd);
    const rest = input.slice(lineEnd + 2);
    const type = line[0];
    const payload = line.slice(1);
    switch (type) {
      case "+":
        return { value: payload, rest };
      case "-":
        return { value: new RedisError({ reason: `server error: ${payload}` }), rest };
      case ":": {
        const asNumber = Number(payload);
        return Number.isFinite(asNumber)
          ? { value: asNumber, rest }
          : { value: new RedisError({ reason: `bad integer reply: ${payload}` }), rest };
      }
      case "$": {
        const length = Number(payload);
        if (!Number.isFinite(length) || length < 0) {
          if (length === -1) return { value: undefined, rest };
          return { value: new RedisError({ reason: `bad bulk reply: ${payload}` }), rest };
        }
        if (rest.length < length + 2) return undefined;
        return { value: rest.slice(0, length), rest: rest.slice(length + 2) };
      }
      case "*": {
        const count = Number(payload);
        if (!Number.isFinite(count)) {
          return { value: new RedisError({ reason: `bad array reply: ${payload}` }), rest };
        }
        if (count < 0) return { value: undefined, rest };
        let remaining = rest;
        const items: Array<unknown> = [];
        for (let index = 0; index < count; index++) {
          const item = parseReply(remaining);
          if (item === undefined) return undefined;
          items.push(item.value);
          remaining = item.rest;
        }
        return { value: items, rest: remaining };
      }
      default:
        return { value: new RedisError({ reason: `unknown reply type: ${type}` }), rest };
    }
  };

  const drain = (): void => {
    for (;;) {
      const reply = parseReply(buffer);
      if (reply === undefined) return;
      buffer = reply.rest;
      const waiter = pending.shift();
      if (waiter === undefined) continue;
      if (reply.value instanceof RedisError) waiter.reject(reply.value);
      else waiter.resolve(reply.value);
    }
  };

  const connect = (): Promise<net.Socket> =>
    new Promise((resolve, reject) => {
      const connection = net.connect({ host, port });
      connection.setNoDelay(true);
      const timer = setTimeout(() => {
        connection.destroy();
        reject(new RedisError({ reason: "connect timeout" }));
      }, connectTimeout);
      connection.once("error", (error) => {
        clearTimeout(timer);
        connection.destroy();
        socket = undefined;
        failPending(new RedisError({ reason: "connection failed", cause: error }));
        reject(new RedisError({ reason: "connection failed", cause: error }));
      });
      connection.once("connect", () => {
        clearTimeout(timer);
        socket = connection;
        connection.on("error", (error) => {
          socket = undefined;
          failPending(new RedisError({ reason: "connection lost", cause: error }));
        });
        connection.on("close", () => {
          if (socket === connection) socket = undefined;
          failPending(new RedisError({ reason: "connection closed" }));
        });
        connection.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          drain();
        });
        resolve(connection);
      });
    });

  const ensureSocket = async (): Promise<net.Socket> =>
    socket === undefined || socket.destroyed ? connect() : socket;

  const writeAndAwait = async (parts: ReadonlyArray<string>): Promise<unknown> => {
    const connection = await ensureSocket();
    return new Promise<unknown>((resolve, reject) => {
      pending.push({ resolve, reject });
      connection.write(encodeCommand(parts), (error) => {
        if (error === null || error === undefined) return;
        failPending(new RedisError({ reason: "write failed", cause: error }));
      });
    });
  };

  /** Serializes commands: one in flight, replies matched in order. */
  const serialized = (parts: ReadonlyArray<string>): Promise<unknown> => {
    const run = chain.then(() => writeAndAwait(parts));
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  let ready: Promise<void> | undefined;
  const setup = async (): Promise<void> => {
    await ensureSocket();
    if (password !== undefined) {
      await serialized(username !== undefined ? ["AUTH", username, password] : ["AUTH", password]);
    }
    if (dbNumber !== undefined) await serialized(["SELECT", dbNumber]);
  };

  return {
    eval: (script, keys, args) =>
      Effect.tryPromise({
        try: async () => {
          if (closed) throw new RedisError({ reason: "client closed" });
          ready ??= setup();
          try {
            await ready;
          } catch (cause) {
            ready = undefined;
            throw cause;
          }
          return await serialized(["EVAL", script, String(keys.length), ...keys, ...args]);
        },
        catch: (cause): RedisError =>
          cause instanceof RedisError ? cause : new RedisError({ reason: "eval failed", cause }),
      }),
    close: () => {
      closed = true;
      socket?.destroy();
      failPending(new RedisError({ reason: "client closed" }));
    },
  };
};
