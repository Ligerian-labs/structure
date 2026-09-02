import type { ObjectKey } from "./key.js";

/**
 * How a stored object may be served back. The default is `attachment`:
 * user content is never rendered on the app origin. `inline-if-isolated`
 * only downgrades to `inline` when the object's content type is on the
 * inline allowlist (images and plain text — never HTML, SVG, or PDF, which
 * can execute or smuggle same-origin content).
 */
export type Disposition = "attachment" | "inline-if-isolated";

/** Conservative default allowlist for inline serving. */
export const DEFAULT_INLINE_ALLOWLIST: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "text/plain",
]);

export interface DispositionPolicy {
  readonly inlineAllowlist: ReadonlySet<string>;
}

export const dispositionPolicy = (
  inlineAllowlist: ReadonlyArray<string> = [...DEFAULT_INLINE_ALLOWLIST],
): DispositionPolicy => ({
  inlineAllowlist: new Set(inlineAllowlist.map((value) => value.split(";")[0]?.trim() ?? "")),
});

const baseContentType = (contentType: string | undefined): string =>
  (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";

const safeFilename = (key: ObjectKey): string => {
  const segment = key.split("/").at(-1) ?? "download";
  const cleaned = segment.replace(/[^A-Za-z0-9._-]/gu, "");
  return cleaned.length > 0 && cleaned !== "." && cleaned !== ".." ? cleaned : "download";
};

/**
 * The serving headers every `get`/`head` carries. Enforced at the port, not
 * the driver: `Content-Disposition: attachment` unless the caller declared
 * `inline-if-isolated` AND the content type is allowlisted, and always
 * `X-Content-Type-Options: nosniff`.
 */
export const servingHeaders = (
  object: {
    readonly key: ObjectKey;
    readonly contentType?: string;
    readonly disposition: Disposition;
  },
  policy: DispositionPolicy = dispositionPolicy(),
): Readonly<Record<string, string>> => {
  const contentType = object.contentType ?? "application/octet-stream";
  const inline =
    object.disposition === "inline-if-isolated" &&
    policy.inlineAllowlist.has(baseContentType(contentType));
  return {
    "content-type": contentType,
    "content-disposition": inline ? "inline" : `attachment; filename="${safeFilename(object.key)}"`,
    "x-content-type-options": "nosniff",
    "cache-control": "private, max-age=0, must-revalidate",
  };
};

const CONTENT_TYPE_PATTERN =
  /^[!#$%&'*+.^_`|~0-9A-Za-z/-]+(?:\s*;\s*[!#$%&'*+.^_`|~0-9A-Za-z/-]+=[^\r\n;]{0,255})?$/u;

/** Validates a content type against header-injection and shape rules. */
export const validContentType = (contentType: string): boolean =>
  contentType.length <= 255 && CONTENT_TYPE_PATTERN.test(contentType);
