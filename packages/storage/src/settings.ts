import { Settings } from "@structure-ai/config";
import { type Config, Effect, Option } from "effect";
import { makeLocalStorage } from "./drivers/local.js";
import { makeS3Storage } from "./drivers/s3.js";
import { StorageValidationError } from "./errors.js";
import { DEFAULT_INLINE_ALLOWLIST, dispositionPolicy } from "./policy.js";
import type { Storage } from "./storage.js";

/**
 * Standard storage settings — flat, validated at composition time. Secrets
 * (`STORAGE_S3_SECRET_ACCESS_KEY`) load as `Redacted` values. The inline
 * content-type allowlist is a comma-separated string applied on top of the
 * conservative default set.
 */
export const storageSettings = Settings.struct({
  driver: Settings.literal("STORAGE_DRIVER", ["local", "s3"], {
    description: "storage driver: local filesystem or S3",
    default: "local",
  }),
  dataDir: Settings.optional(
    Settings.string("STORAGE_DATA_DIR", {
      description: "root directory for the local driver (required when driver=local)",
    }),
  ),
  s3Bucket: Settings.optional(
    Settings.string("STORAGE_S3_BUCKET", { description: "S3 bucket (required when driver=s3)" }),
  ),
  s3Region: Settings.optional(
    Settings.string("STORAGE_S3_REGION", { description: "S3 region (required when driver=s3)" }),
  ),
  s3Endpoint: Settings.optional(
    Settings.url("STORAGE_S3_ENDPOINT", {
      description: "S3 path-style endpoint override (MinIO, tests)",
    }),
  ),
  s3AccessKeyId: Settings.optional(
    Settings.string("STORAGE_S3_ACCESS_KEY_ID", {
      description: "S3 access key id (required when driver=s3)",
    }),
  ),
  s3SecretAccessKey: Settings.optional(
    Settings.secret("STORAGE_S3_SECRET_ACCESS_KEY", {
      description: "S3 secret access key (required when driver=s3)",
    }),
  ),
  inlineContentTypes: Settings.optional(
    Settings.string("STORAGE_INLINE_CONTENT_TYPES", {
      description:
        "comma-separated extra content types allowed for inline serving (the safe image/text defaults are always included)",
    }),
  ),
});

export type StorageSettingsValue =
  (typeof storageSettings)["config"] extends Config.Config<infer A> ? A : never;

const missing = (setting: string): StorageValidationError =>
  new StorageValidationError({ field: setting, reason: "is required for the selected driver" });

const inlineAllowlist = (value: Option.Option<string>): ReadonlyArray<string> => {
  const configured = Option.isSome(value)
    ? Option.getOrThrow(value)
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : [];
  return [...DEFAULT_INLINE_ALLOWLIST, ...configured];
};

/**
 * Builds the driver a `storageSettings` value selects, validating the
 * combination (local needs a data dir; s3 needs bucket/region/credentials)
 * — misconfiguration fails with a typed error at composition.
 */
export const storageFromSettings = (
  settings: StorageSettingsValue,
): Effect.Effect<Storage, StorageValidationError> =>
  Effect.gen(function* () {
    const policy = dispositionPolicy(inlineAllowlist(settings.inlineContentTypes));
    switch (settings.driver) {
      case "local":
        return yield* Option.match(settings.dataDir, {
          onNone: () => Effect.fail(missing("STORAGE_DATA_DIR")),
          onSome: (dataDir) => Effect.succeed(makeLocalStorage({ rootDir: dataDir, policy })),
        });
      case "s3":
        return yield* Option.match(settings.s3Bucket, {
          onNone: () => Effect.fail(missing("STORAGE_S3_BUCKET")),
          onSome: (bucket) =>
            Option.isNone(settings.s3Region) ||
            Option.isNone(settings.s3AccessKeyId) ||
            Option.isNone(settings.s3SecretAccessKey)
              ? Effect.fail(
                  new StorageValidationError({
                    field: "STORAGE_S3_REGION/ACCESS_KEY_ID/SECRET_ACCESS_KEY",
                    reason: "all are required when driver=s3",
                  }),
                )
              : Effect.succeed(
                  makeS3Storage({
                    bucket,
                    region: Option.getOrThrow(settings.s3Region),
                    accessKeyId: Option.getOrThrow(settings.s3AccessKeyId),
                    secretAccessKey: Option.getOrThrow(settings.s3SecretAccessKey),
                    ...(Option.isSome(settings.s3Endpoint)
                      ? { endpoint: Option.getOrThrow(settings.s3Endpoint).toString() }
                      : {}),
                    policy,
                  }),
                ),
        });
    }
  });
