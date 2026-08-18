import { Layer, LogLevel, Option } from "effect";
import { layerJson, layerMinimumLevel, layerPretty } from "./Logging.js";
import { layerOtlp } from "./Otlp.js";
import { ServiceMeta } from "./ServiceMeta.js";

export interface ObservabilityOptions {
  readonly service: {
    readonly name: string;
    readonly version?: string;
    readonly instance?: string;
  };
  readonly logLevel?: LogLevel.LogLevel;
  readonly logFormat?: "json" | "pretty";
  readonly otlpUrl?: Option.Option<URL> | URL | string;
}

const otlpBaseUrl = (value: ObservabilityOptions["otlpUrl"]): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (value instanceof URL) return value.toString();
  return Option.isSome(value) ? value.value.toString() : undefined;
};

/**
 * One layer for the full observability stack: service identity, structured
 * logging, minimum level, and (when configured) OTLP export of traces,
 * metrics, and logs.
 */
export const layer = (options: ObservabilityOptions): Layer.Layer<ServiceMeta> => {
  const service = ServiceMeta.layer(options.service);
  const logger = options.logFormat === "pretty" ? layerPretty : layerJson();
  const level = layerMinimumLevel(options.logLevel ?? LogLevel.Info);
  const baseUrl = otlpBaseUrl(options.otlpUrl);
  const exporter = baseUrl === undefined ? Layer.empty : layerOtlp({ baseUrl });
  return Layer.mergeAll(logger, level, exporter).pipe(Layer.provideMerge(service));
};
