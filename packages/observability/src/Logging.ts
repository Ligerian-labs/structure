import { Cause, Effect, HashMap, Layer, List, Logger, LogLevel } from "effect";
import { ServiceMeta } from "./ServiceMeta.js";

const MAX_STRING = 2048;
const MAX_ANNOTATIONS = 64;

const truncate = (s: string): string =>
  s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}…[truncated]` : s;

const serialize = (value: unknown): unknown => {
  if (typeof value === "string") return truncate(value);
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null ||
    value === undefined
  ) {
    return value;
  }
  try {
    // String() honors Redacted/Secret redaction and Effect toString overrides.
    return truncate(String(value));
  } catch {
    return "[unserializable]";
  }
};

export interface LogRecord {
  readonly ts: string;
  readonly level: string;
  readonly event: string;
  readonly service: { readonly name: string; readonly version: string; readonly instance: string };
  readonly annotations: Record<string, unknown>;
  readonly spans: ReadonlyArray<string>;
  readonly error?: string;
}

/**
 * Structured JSON logger: one line per record on stdout, stable field names,
 * bounded sizes, annotations carried through, causes rendered once.
 */
export const makeJsonLogger = (
  service: { name: string; version: string; instance: string },
  write: (line: string) => void = (line) => globalThis.console.log(line),
): Logger.Logger<unknown, void> =>
  Logger.make(({ annotations, cause, date, logLevel, message, spans }) => {
    const ann: Record<string, unknown> = {};
    let count = 0;
    for (const [key, value] of HashMap.entries(annotations)) {
      if (count >= MAX_ANNOTATIONS) break;
      ann[key] = serialize(value);
      count += 1;
    }
    const messages = Array.isArray(message) ? message : [message];
    const record: LogRecord = {
      ts: date.toISOString(),
      level: logLevel.label,
      event: messages
        .map((m) => (typeof m === "string" ? truncate(m) : String(serialize(m))))
        .join(" "),
      service,
      annotations: ann,
      spans: List.toArray(spans).map((s) => s.label),
      ...(Cause.isEmpty(cause) ? {} : { error: truncate(Cause.pretty(cause)) }),
    };
    write(JSON.stringify(record));
  });

/** Replaces the default logger with the structured JSON logger. */
export const layerJson = (write?: (line: string) => void): Layer.Layer<never, never, ServiceMeta> =>
  Layer.unwrapEffect(
    Effect.map(ServiceMeta, (service) =>
      Logger.replace(Logger.defaultLogger, makeJsonLogger(service, write)),
    ),
  );

/** Minimum-level filter as a standalone layer. */
export const layerMinimumLevel = (level: LogLevel.LogLevel): Layer.Layer<never> =>
  Logger.minimumLogLevel(level);

/** Human-oriented logger for local development. */
export const layerPretty: Layer.Layer<never> = Logger.pretty;

/** Drops all log output — for tests that assert on behavior, not logs. */
export const layerSilent: Layer.Layer<never> = Logger.minimumLogLevel(LogLevel.None);
