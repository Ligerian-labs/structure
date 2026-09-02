import { Effect } from "effect";
import { StorageValidationError } from "./errors.js";

declare const ObjectKeyBrand: unique symbol;

/**
 * An opaque, validated storage key. Only `objectKey` and `randomObjectKey`
 * produce values — never build one by casting. Keys are path-shaped
 * (`segment/segment/...`) with a restricted charset, no `.`/`..` segments,
 * and no leading or trailing slash, so they can never traverse outside a
 * driver's root.
 */
export type ObjectKey = string & { readonly [ObjectKeyBrand]: true };

const MAX_KEY_LENGTH = 1_024;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;

/** Pure validation predicate (the rules `objectKey` enforces). */
export const isValidKey = (raw: string): boolean => {
  if (raw.length === 0 || raw.length > MAX_KEY_LENGTH) return false;
  if (raw.startsWith("/") || raw.endsWith("/")) return false;
  if (raw.includes("\\")) return false;
  for (const segment of raw.split("/")) {
    if (!SEGMENT.test(segment)) return false;
  }
  return true;
};

/** Validates and brands a raw string as an {@link ObjectKey}. */
export const objectKey = (raw: string): Effect.Effect<ObjectKey, StorageValidationError> =>
  Effect.suspend(() =>
    isValidKey(raw)
      ? Effect.succeed(raw as ObjectKey)
      : Effect.fail(
          new StorageValidationError({
            field: "key",
            reason:
              "must be 1..1024 chars, slash-separated segments of [A-Za-z0-9._-], no empty/./.. segments, no backslashes",
          }),
        ),
  );

/**
 * Generates a fresh unguessable key under `prefix` (default `objects`),
 * optionally with a file extension (include the dot, e.g. `".png"`).
 */
export const randomObjectKey = (
  options: { readonly prefix?: string; readonly extension?: string } = {},
): Effect.Effect<ObjectKey, StorageValidationError> =>
  objectKey(`${options.prefix ?? "objects"}/${crypto.randomUUID()}${options.extension ?? ""}`);

export const keyToString = (key: ObjectKey): string => key;
