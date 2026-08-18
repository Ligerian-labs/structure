import { Otlp } from "@effect/opentelemetry";
import { FetchHttpClient } from "@effect/platform";
import { Effect, Layer } from "effect";
import { ServiceMeta } from "./ServiceMeta.js";

/**
 * Exports traces, metrics, and logs to an OTLP endpoint using the
 * pure-Effect exporter (no OpenTelemetry JS SDK involved). Telemetry export
 * failures never take down the primary workload.
 */
export const layerOtlp = (options: {
  readonly baseUrl: string;
  readonly headers?: Record<string, string>;
}): Layer.Layer<never, never, ServiceMeta> =>
  Layer.unwrapEffect(
    Effect.map(ServiceMeta, (service) =>
      Otlp.layerJson({
        baseUrl: options.baseUrl,
        resource: {
          serviceName: service.name,
          serviceVersion: service.version,
          attributes: { "service.instance.id": service.instance },
        },
        ...(options.headers !== undefined ? { headers: options.headers } : {}),
      }).pipe(Layer.provide(FetchHttpClient.layer)),
    ),
  );
