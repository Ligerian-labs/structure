import { Context, Layer } from "effect";

/**
 * Identity of the running service, attached to every log record, span
 * resource, and metric export.
 */
export class ServiceMeta extends Context.Tag("@structure/observability/ServiceMeta")<
  ServiceMeta,
  {
    readonly name: string;
    readonly version: string;
    readonly instance: string;
  }
>() {
  static layer(values: {
    name: string;
    version?: string;
    instance?: string;
  }): Layer.Layer<ServiceMeta> {
    return Layer.succeed(ServiceMeta, {
      name: values.name,
      version: values.version ?? "0.0.0",
      instance: values.instance ?? crypto.randomUUID(),
    });
  }
}
