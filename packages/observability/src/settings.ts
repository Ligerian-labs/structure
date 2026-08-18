import { Settings } from "@structure-ai/config";

/**
 * Standard observability settings. Nest under a prefix if the host app
 * needs to: `Settings.nested("OBS", observabilitySettings)`.
 */
export const observabilitySettings = Settings.struct({
  logLevel: Settings.logLevel("LOG_LEVEL", { description: "minimum log level" }),
  logFormat: Settings.literal("LOG_FORMAT", ["json", "pretty"], {
    description: "log output format",
    default: "json",
  }),
  otlpUrl: Settings.optional(
    Settings.url("OTLP_URL", {
      description: "OTLP collector base URL; telemetry export is off when unset",
    }),
  ),
});
