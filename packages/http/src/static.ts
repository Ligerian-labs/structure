import { realpath, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import { Data, Effect, Option } from "effect";
import { underPrefix } from "./mounts.js";

/**
 * Bounded file serving for an embedded SPA build: files below `directory`
 * only (decoded path segments, no `.`/`..`/dotfiles, symlink targets checked
 * against the real root), `GET`/`HEAD` only, directories answer with their
 * `index.html` or nothing (never a listing), every response carries
 * `x-content-type-options: nosniff`, a weak `etag` (answering `304` to a
 * matching `if-none-match`) and `vary: accept-encoding`. A precompressed
 * sibling (`<file>.br`, then `<file>.gz`) is served with the matching
 * `content-encoding` when the client accepts it. No range requests.
 */
export interface StaticOptions {
  /** Root directory of the built assets. Resolved against the process cwd. */
  readonly directory: string;
  /**
   * Path prefix the directory is served under. Default: `/`. Same shape as a
   * mount prefix (absolute, no trailing slash, no query).
   */
  readonly prefix?: string;
  /**
   * File (relative to `directory`, e.g. `index.html`) served for paths that
   * match no file — only for navigations, i.e. `GET`/`HEAD` requests whose
   * `Accept` header lists `text/html`. API clients still get the 404 problem.
   */
  readonly spaFallback?: string;
  /**
   * `cache-control` value per served file (path relative to `directory`,
   * leading `/`; the fallback is reported under its own path). Default:
   * `no-cache` for everything, which keeps hashed assets correct at the cost
   * of a conditional request per load — return `public, max-age=31536000,
   * immutable` for hashed asset paths.
   */
  readonly cacheControl?: (path: string) => string;
}

/** Static options that cannot be served deterministically. */
export class InvalidStaticOptions extends Data.TaggedError("InvalidStaticOptions")<{
  readonly violations: ReadonlyArray<string>;
}> {
  readonly classification: "permanent" = "permanent";
  override get message(): string {
    return `invalid static options: ${this.violations.join("; ")}`;
  }
}

/**
 * Resolves and serves files for the static middleware. `serve` yields `None`
 * whenever the request is not a static file (wrong method, outside the
 * prefix, refused path, missing file) so the caller can fall through to the
 * HttpApi 404 mapping.
 */
export interface StaticServer {
  readonly serve: (
    request: StaticRequest,
    path: string,
  ) => Effect.Effect<Option.Option<HttpServerResponse.HttpServerResponse>>;
}

/** The slice of a request static serving needs. */
export interface StaticRequest {
  readonly method: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

interface Located {
  /** Absolute path of the file on disk (the real path, inside the root). */
  readonly file: string;
  /** Path relative to the root with a leading `/`, for `cacheControl`. */
  readonly relative: string;
}

interface Variant {
  readonly file: string;
  readonly encoding: "br" | "gzip" | undefined;
  readonly size: number;
  readonly mtime: Date;
}

/** Control bytes (including NUL), DEL and backslashes never belong in an asset path. */
const hasForbiddenChar = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f || code === 0x5c) return true;
  }
  return false;
};

const unsafeSegment = (segment: string): boolean =>
  segment === "." || segment === ".." || segment.startsWith(".");

/**
 * Splits a decoded request path into safe segments, or `undefined` when the
 * path must be refused (undecodable, control bytes, backslashes, dot
 * segments, dotfiles).
 */
export const safeSegments = (encodedPath: string): ReadonlyArray<string> | undefined => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(encodedPath);
  } catch {
    return undefined;
  }
  if (hasForbiddenChar(decoded)) return undefined;
  const segments = decoded.split("/").filter((segment) => segment.length > 0);
  return segments.some(unsafeSegment) ? undefined : segments;
};

const validateOptions = (options: StaticOptions): ReadonlyArray<string> => {
  const violations: Array<string> = [];
  if (options.directory.length === 0) violations.push("directory must not be empty");
  const prefix = options.prefix ?? "/";
  if (!prefix.startsWith("/")) violations.push(`prefix "${prefix}" must start with "/"`);
  if (prefix.length > 1 && prefix.endsWith("/")) {
    violations.push(`prefix "${prefix}" must not end with "/"`);
  }
  if (prefix.includes("?") || prefix.includes("#")) {
    violations.push(`prefix "${prefix}" must not contain a query or fragment`);
  }
  if (options.spaFallback !== undefined) {
    const segments = safeSegments(options.spaFallback);
    if (segments === undefined || segments.length === 0) {
      violations.push(`spaFallback "${options.spaFallback}" must be a safe relative file path`);
    }
  }
  return violations;
};

const isInside = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(root + sep);

const fileStat = async (path: string): Promise<{ size: number; mtime: Date } | undefined> => {
  try {
    const info = await stat(path);
    return info.isFile() ? { size: info.size, mtime: info.mtime } : undefined;
  } catch {
    return undefined;
  }
};

const isDirectory = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

/** Comma-separated header members without their parameters, lower-cased. */
const members = (header: string | undefined): ReadonlyArray<string> =>
  header === undefined
    ? []
    : header.split(",").map((token) => token.trim().split(";")[0]?.trim().toLowerCase() ?? "");

const acceptsEncoding = (header: string | undefined, encoding: string): boolean =>
  members(header).includes(encoding);

const acceptsHtml = (header: string | undefined): boolean => members(header).includes("text/html");

const weakEtag = (variant: Variant): string =>
  `W/"${variant.size.toString(16)}-${variant.mtime.getTime().toString(16)}"`;

const etagMatches = (header: string | undefined, etag: string): boolean =>
  (header ?? "").split(",").some((token) => {
    const candidate = token.trim();
    return candidate === "*" || candidate === etag;
  });

/**
 * Builds a static server. Configuration violations are returned instead of
 * thrown so the caller decides how to surface them at layer construction.
 */
export const makeStatic = (
  options: StaticOptions,
): { readonly server: StaticServer; readonly violations: ReadonlyArray<string> } => {
  const violations = validateOptions(options);
  const prefix = options.prefix ?? "/";
  const root = resolve(options.directory);
  const cacheControl = options.cacheControl ?? (() => "no-cache");
  const fallbackSegments =
    options.spaFallback === undefined ? undefined : safeSegments(options.spaFallback);

  // The real root is resolved once: a symlinked build directory is fine, but
  // every served file must resolve inside it.
  let realRoot: Promise<string | undefined> | undefined;
  const resolveRoot = (): Promise<string | undefined> => {
    realRoot ??= realpath(root).catch(() => undefined);
    return realRoot;
  };

  /** Locates a regular file for the given safe segments, or nothing. */
  const locate = async (
    rootPath: string,
    segments: ReadonlyArray<string>,
  ): Promise<Located | undefined> => {
    let candidate = join(rootPath, ...segments);
    if (!isInside(rootPath, candidate)) return undefined;
    if (await isDirectory(candidate)) candidate = join(candidate, "index.html");
    if ((await fileStat(candidate)) === undefined) return undefined;
    let real: string;
    try {
      real = await realpath(candidate);
    } catch {
      return undefined;
    }
    if (!isInside(rootPath, real)) return undefined;
    return { file: real, relative: `/${relative(rootPath, real).split(sep).join("/")}` };
  };

  /** Picks the precompressed sibling the client accepts, else the file itself. */
  const pickVariant = async (
    located: Located,
    acceptEncoding: string | undefined,
  ): Promise<Variant | undefined> => {
    const candidates: ReadonlyArray<{ suffix: string; encoding: "br" | "gzip" }> = [
      { suffix: ".br", encoding: "br" },
      { suffix: ".gz", encoding: "gzip" },
    ];
    for (const candidate of candidates) {
      if (!acceptsEncoding(acceptEncoding, candidate.encoding)) continue;
      const info = await fileStat(located.file + candidate.suffix);
      if (info !== undefined) {
        return { file: located.file + candidate.suffix, encoding: candidate.encoding, ...info };
      }
    }
    const info = await fileStat(located.file);
    return info === undefined ? undefined : { file: located.file, encoding: undefined, ...info };
  };

  const respond = (
    request: StaticRequest,
    located: Located,
    variant: Variant,
  ): HttpServerResponse.HttpServerResponse => {
    const etag = weakEtag(variant);
    const headers: Record<string, string> = {
      "x-content-type-options": "nosniff",
      "cache-control": cacheControl(located.relative),
      vary: "accept-encoding",
      etag,
      "last-modified": variant.mtime.toUTCString(),
    };
    if (etagMatches(request.headers["if-none-match"], etag)) {
      return HttpServerResponse.empty({ status: 304, headers });
    }
    headers["content-type"] = Bun.file(located.file).type;
    headers["content-length"] = String(variant.size);
    if (variant.encoding !== undefined) headers["content-encoding"] = variant.encoding;
    return HttpServerResponse.raw(Bun.file(variant.file), { status: 200, headers });
  };

  const serve = async (
    request: StaticRequest,
    path: string,
  ): Promise<Option.Option<HttpServerResponse.HttpServerResponse>> => {
    if (request.method !== "GET" && request.method !== "HEAD") return Option.none();
    if (!underPrefix(prefix, path)) return Option.none();
    const below = prefix === "/" ? path : path.slice(prefix.length);
    const segments = safeSegments(below);
    if (segments === undefined) return Option.none();
    const rootPath = await resolveRoot();
    if (rootPath === undefined) return Option.none();

    let located = await locate(rootPath, segments);
    if (
      located === undefined &&
      fallbackSegments !== undefined &&
      acceptsHtml(request.headers.accept)
    ) {
      located = await locate(rootPath, fallbackSegments);
    }
    if (located === undefined) return Option.none();
    const variant = await pickVariant(located, request.headers["accept-encoding"]);
    return variant === undefined ? Option.none() : Option.some(respond(request, located, variant));
  };

  return {
    violations,
    server: {
      serve: (request, path) =>
        Effect.promise(() => serve(request, path)).pipe(
          // Any filesystem surprise is "not a static file": the request falls
          // through to the HttpApi mapping instead of leaking a defect.
          Effect.catchAllCause(() => Effect.succeed(Option.none())),
        ),
    },
  };
};
