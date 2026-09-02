import { Cause, Effect, HashMap, Layer, List, Logger, LogLevel, Redacted } from "effect";
import { ServiceMeta } from "./ServiceMeta.js";

const MAX_STRING = 2048;
const MAX_KEYS = 64;
const MAX_ITEMS = 128;
const MAX_DEPTH = 8;

const KEYS_TRUNCATED = "…[truncated]";
const DEPTH_TRUNCATED = "[truncated: depth]";
const CIRCULAR = "[circular]";
const REDACTED_VALUE = "<redacted>";
const REDACTED_KEY = "[redacted]";

const truncate = (s: string): string =>
  s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}…[truncated]` : s;

/** Options shared by `makeJsonLogger`, `layerJson`, and `layer`. */
export interface JsonLoggerOptions {
  /**
   * Keys whose values render as `"[redacted]"` wherever they appear in
   * annotations or structured message values, at any depth. Matching is
   * case-insensitive. Second wall behind `Redacted` values, for payloads the
   * caller did not build.
   */
  readonly redactKeys?: ReadonlyArray<string>;
}

interface Serializer {
  readonly value: (value: unknown) => unknown;
  readonly entries: (entries: Iterable<readonly [string, unknown]>) => Record<string, unknown>;
}

const isPlainStringable = (value: object): boolean =>
  typeof (value as { toString?: unknown }).toString === "function" &&
  (value as { toString: unknown }).toString !== Object.prototype.toString;

const hasToJSON = (value: object): value is { toJSON: () => unknown } =>
  typeof (value as { toJSON?: unknown }).toJSON === "function";

/**
 * JSON-compatible rendering of arbitrary values, bounded on every axis
 * (string length, key count, array length, depth) with explicit truncation
 * markers. Cycles render as `"[circular]"` instead of throwing.
 */
const makeSerializer = (redactKeys: ReadonlyArray<string>): Serializer => {
  const redacted = new Set(redactKeys.map((k) => k.toLowerCase()));
  const isRedactedKey = (key: string): boolean =>
    redacted.size > 0 && redacted.has(key.toLowerCase());

  const entries = (
    source: Iterable<readonly [string, unknown]>,
    depth: number,
    seen: Set<object>,
  ): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    let count = 0;
    let dropped = 0;
    for (const [key, value] of source) {
      if (count >= MAX_KEYS) {
        dropped += 1;
        continue;
      }
      out[key] = isRedactedKey(key) ? REDACTED_KEY : go(value, depth, seen);
      count += 1;
    }
    if (dropped > 0) out[KEYS_TRUNCATED] = dropped;
    return out;
  };

  const items = (source: Iterable<unknown>, depth: number, seen: Set<object>): Array<unknown> => {
    const out: Array<unknown> = [];
    let dropped = 0;
    for (const value of source) {
      if (out.length >= MAX_ITEMS) {
        dropped += 1;
        continue;
      }
      out.push(go(value, depth, seen));
    }
    if (dropped > 0) out.push(`…[truncated: ${dropped}]`);
    return out;
  };

  const errorEntries = (error: Error): Array<readonly [string, unknown]> => [
    ["name", error.name],
    ["message", error.message],
    ...Object.entries(error).filter(([key]) => key !== "stack"),
  ];

  const go = (value: unknown, depth: number, seen: Set<object>): unknown => {
    if (typeof value === "string") return truncate(value);
    if (
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null ||
      value === undefined
    ) {
      return value;
    }
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "function") return "[function]";
    if (typeof value !== "object") return truncate(String(value));
    if (Redacted.isRedacted(value)) return REDACTED_VALUE;
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? "[invalid date]" : value.toISOString();
    }
    if (seen.has(value)) return CIRCULAR;
    if (depth >= MAX_DEPTH) return DEPTH_TRUNCATED;
    seen.add(value);
    try {
      if (value instanceof Error) return entries(errorEntries(value), depth + 1, seen);
      if (Array.isArray(value)) return items(value, depth + 1, seen);
      if (value instanceof Set) return items(value, depth + 1, seen);
      if (value instanceof Map) {
        return entries(
          Array.from(value, ([k, v]) => [typeof k === "string" ? k : String(k), v] as const),
          depth + 1,
          seen,
        );
      }
      // Effect data types (Schema classes, Option, Chunk…) expose toJSON.
      if (hasToJSON(value)) return go(value.toJSON(), depth + 1, seen);
      // A custom toString (URL, RegExp, Secret…) is the value's own rendering.
      if (isPlainStringable(value)) return truncate(String(value));
      return entries(Object.entries(value), depth + 1, seen);
    } catch {
      return "[unserializable]";
    } finally {
      seen.delete(value);
    }
  };

  return {
    value: (value) => go(value, 0, new Set()),
    entries: (source) => entries(source, 0, new Set()),
  };
};

export interface LogRecord {
  readonly ts: string;
  readonly level: string;
  readonly event: string;
  readonly service: { readonly name: string; readonly version: string; readonly instance: string };
  readonly annotations: Record<string, unknown>;
  readonly spans: ReadonlyArray<string>;
  /** Structured (non-string) message values, when the log call carried any. */
  readonly data?: unknown;
  readonly error?: string;
}

/**
 * Structured JSON logger: one line per record on stdout, stable field names,
 * bounded sizes, annotations carried through as JSON structure, causes
 * rendered once. See `JsonLoggerOptions` for key-based redaction.
 */
export const makeJsonLogger = (
  service: { name: string; version: string; instance: string },
  write: (line: string) => void = (line) => globalThis.console.log(line),
  options: JsonLoggerOptions = {},
): Logger.Logger<unknown, void> => {
  const serializer = makeSerializer(options.redactKeys ?? []);
  return Logger.make(({ annotations, cause, date, logLevel, message, spans }) => {
    const ann = serializer.entries(HashMap.entries(annotations));
    const messages = Array.isArray(message) ? message : [message];
    const text = messages.filter((m): m is string => typeof m === "string").map(truncate);
    const structured = messages.filter((m) => typeof m !== "string").map(serializer.value);
    const data =
      structured.length === 0 ? {} : { data: structured.length === 1 ? structured[0] : structured };
    const event =
      text.length > 0
        ? text.join(" ")
        : truncate(structured.map((s) => JSON.stringify(s) ?? String(s)).join(" "));
    const record: LogRecord = {
      ts: date.toISOString(),
      level: logLevel.label,
      event,
      service,
      annotations: ann,
      spans: List.toArray(spans).map((s) => s.label),
      ...data,
      ...(Cause.isEmpty(cause) ? {} : { error: truncate(Cause.pretty(cause)) }),
    };
    write(JSON.stringify(record));
  });
};

/** Replaces the default logger with the structured JSON logger. */
export const layerJson = (
  write?: (line: string) => void,
  options?: JsonLoggerOptions,
): Layer.Layer<never, never, ServiceMeta> =>
  Layer.unwrapEffect(
    Effect.map(ServiceMeta, (service) =>
      Logger.replace(Logger.defaultLogger, makeJsonLogger(service, write, options)),
    ),
  );

/** Minimum-level filter as a standalone layer. */
export const layerMinimumLevel = (level: LogLevel.LogLevel): Layer.Layer<never> =>
  Logger.minimumLogLevel(level);

/** Human-oriented logger for local development. */
export const layerPretty: Layer.Layer<never> = Logger.pretty;

/** Drops all log output — for tests that assert on behavior, not logs. */
export const layerSilent: Layer.Layer<never> = Logger.minimumLogLevel(LogLevel.None);
