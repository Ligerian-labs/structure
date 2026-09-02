import { Data } from "effect";

/**
 * A raw web handler mounted under a path prefix beside the `HttpApi`:
 * `makeAuthHandler` from `@structure-ai/auth`, an MCP transport turned into a
 * web handler, a proxy — anything shaped `(Request) => Promise<Response>`.
 *
 * The handler receives the request untouched (full path, query, headers,
 * body): prefix stripping is the handler's business, exactly as it would be on
 * its own `Bun.serve`. Responses are returned as-is, with the correlation
 * headers stamped on top. A handler that rejects is a defect — the request is
 * answered with the 500 problem carrying only the correlation id.
 */
export interface Mount {
  /**
   * Absolute path prefix: starts with `/`, no trailing slash (except `/`
   * itself), no query or fragment. Matches the prefix path itself and every
   * path below it on a segment boundary (`/api` matches `/api` and
   * `/api/x`, never `/apix`).
   */
  readonly prefix: string;
  readonly handler: (request: Request) => Promise<Response>;
}

/** Mount prefixes that cannot be dispatched deterministically. */
export class InvalidMounts extends Data.TaggedError("InvalidMounts")<{
  readonly violations: ReadonlyArray<string>;
}> {
  readonly classification: "permanent" = "permanent";
  override get message(): string {
    return `invalid mounts: ${this.violations.join("; ")}`;
  }
}

/**
 * A validated mount table: prefixes checked, ordered longest first so the
 * first match is the most specific one.
 */
export interface MountTable {
  readonly mounts: ReadonlyArray<Mount>;
}

const prefixViolation = (prefix: string): string | undefined => {
  if (!prefix.startsWith("/")) return `"${prefix}" must start with "/"`;
  if (prefix.length > 1 && prefix.endsWith("/")) return `"${prefix}" must not end with "/"`;
  if (prefix.includes("?") || prefix.includes("#")) {
    return `"${prefix}" must not contain a query or fragment`;
  }
  if (prefix.includes("//")) return `"${prefix}" must not contain empty segments`;
  return undefined;
};

/**
 * Validates and orders mounts. Fails with {@link InvalidMounts} listing every
 * violation (malformed prefixes, duplicates) so composition bugs surface at
 * startup, not on the first request.
 */
export const compileMounts = (
  mounts: ReadonlyArray<Mount>,
): { readonly table: MountTable; readonly violations: ReadonlyArray<string> } => {
  const violations: Array<string> = [];
  const seen = new Set<string>();
  for (const mount of mounts) {
    const violation = prefixViolation(mount.prefix);
    if (violation !== undefined) violations.push(violation);
    else if (seen.has(mount.prefix)) violations.push(`"${mount.prefix}" is mounted twice`);
    seen.add(mount.prefix);
  }
  const ordered = [...mounts].sort((left, right) => right.prefix.length - left.prefix.length);
  return { table: { mounts: ordered }, violations };
};

/** Whether `path` is the prefix itself or lies below it on a segment boundary. */
export const underPrefix = (prefix: string, path: string): boolean =>
  prefix === "/" || path === prefix || path.startsWith(`${prefix}/`);

/** The most specific mount for a request path, if any. */
export const matchMount = (table: MountTable, path: string): Mount | undefined =>
  table.mounts.find((mount) => underPrefix(mount.prefix, path));
