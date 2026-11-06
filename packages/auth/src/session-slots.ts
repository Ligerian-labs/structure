import { Redacted } from "effect";

/**
 * Session slots: several sessions in one browser, each request naming the
 * one it acts with.
 *
 * A browser keeps one cookie per name and origin, so a second sign-in in the
 * same browser replaces the session of every open tab. A slot is a second,
 * named session cookie beside the usual one, `<cookieName>.<slot>`, and a
 * request names the slot it acts with: the `x-session-slot` header, or the
 * `session_slot` query parameter on GET and HEAD (the addresses a browser
 * loads by itself: an `<img>`, an `<iframe>`, a new tab). A slot is a
 * subject's id: the session held in slot S serves subject S or nobody.
 *
 * A request that names a slot is served by that slot's cookie alone, never by
 * the usual cookie; a request that names none is served by the usual cookie
 * alone, never by a slot's.
 */

/** The header a request names its slot in. */
export const SESSION_SLOT_HEADER = "x-session-slot";

/**
 * The query parameter a request names its slot in, read on GET and HEAD
 * only: a write names its slot in the header, and its query parameter names
 * nothing.
 */
export const SESSION_SLOT_QUERY = "session_slot";

/**
 * A valid slot: 1 to 128 base64url characters, the alphabet of the ids the
 * framework mints (`randomToken`). Safe as it is in a cookie name.
 */
export const SLOT_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Names the slot `sessionCookie` writes and `sessionTokenFromCookie` reads. */
export interface SessionSlotOptions {
  /** A subject's id; must match `SLOT_PATTERN`, or the call fails with `AuthValidationError`. */
  readonly slot?: string;
}

/** What a request names: no slot, a valid slot, or a slot it cannot be served under. */
export type SessionSlotSelection =
  | { readonly _tag: "none" }
  | { readonly _tag: "slot"; readonly slot: string }
  | { readonly _tag: "invalid" };

/**
 * The request facts `requestedSlot` reads. A Web `Request` fits as it is, and
 * so does a request whose headers are a record keyed by lower-cased names
 * (an `@effect/platform` `HttpServerRequest`).
 */
export interface SessionSlotRequest {
  readonly method: string;
  readonly headers:
    | { readonly get: (name: string) => string | null }
    | Readonly<Record<string, string | undefined>>;
  /** Absolute, or a path with its query. */
  readonly url: string;
}

/** The cookie a slot's session travels in: `<cookieName>.<slot>`. */
export const slotCookieName = (cookieName: string, slot: string): string => `${cookieName}.${slot}`;

const NONE: SessionSlotSelection = { _tag: "none" };
const INVALID: SessionSlotSelection = { _tag: "invalid" };

const hasHeaderGetter = (
  headers: SessionSlotRequest["headers"],
): headers is { readonly get: (name: string) => string | null } =>
  typeof headers.get === "function";

const headerOf = (headers: SessionSlotRequest["headers"], name: string): string | undefined =>
  hasHeaderGetter(headers) ? (headers.get(name) ?? undefined) : headers[name];

const queryOf = (url: string): URLSearchParams => {
  const hash = url.indexOf("#");
  const target = hash < 0 ? url : url.slice(0, hash);
  const at = target.indexOf("?");
  return new URLSearchParams(at < 0 ? "" : target.slice(at + 1));
};

/**
 * The slot a request names. The header comes first (a blank one names
 * nothing); the query parameter is read on GET and HEAD only. A header and a
 * query parameter that disagree, two query values that disagree, or a value
 * outside `SLOT_PATTERN` are `invalid`, never a guess: serve such a request
 * under no session at all (the built-in routes answer 400
 * `invalid_session_slot`).
 */
export const requestedSlot = (request: SessionSlotRequest): SessionSlotSelection => {
  const header = headerOf(request.headers, SESSION_SLOT_HEADER)?.trim() ?? "";
  const method = request.method.toUpperCase();
  const queried =
    method === "GET" || method === "HEAD"
      ? [
          ...new Set(
            queryOf(request.url)
              .getAll(SESSION_SLOT_QUERY)
              .map((value) => value.trim())
              .filter((value) => value.length > 0),
          ),
        ]
      : [];
  if (queried.length > 1) return INVALID;
  const query = queried[0] ?? "";
  if (header.length > 0 && query.length > 0 && header !== query) return INVALID;
  const slot = header.length > 0 ? header : query;
  if (slot.length === 0) return NONE;
  return SLOT_PATTERN.test(slot) ? { _tag: "slot", slot } : INVALID;
};

/** The slot a cookie name carries for the session cookie `cookieName`, if it is a slot cookie. */
const slotOf = (cookieName: string, name: string): string | undefined => {
  const prefix = `${cookieName}.`;
  if (!name.startsWith(prefix)) return undefined;
  const slot = name.slice(prefix.length);
  return SLOT_PATTERN.test(slot) ? slot : undefined;
};

const isSlotCookie = (cookieName: string, segment: string): boolean => {
  const separator = segment.indexOf("=");
  return separator >= 0 && slotOf(cookieName, segment.slice(0, separator).trim()) !== undefined;
};

/**
 * Every slot cookie of a `Cookie` header for the session cookie `cookieName`,
 * once per slot (the first pair carrying a value, as the session cookie is
 * read), in the header's order. A cookie whose name holds no valid slot is
 * not a slot cookie. Read them on a slot sign-in to clear the dead ones
 * (`sessionCookie(tenantId, undefined, { slot })`) and to cap the live ones.
 */
export const slotCookiesOf = (
  cookieName: string,
  cookieHeader: string | null | undefined,
): ReadonlyArray<{ readonly slot: string; readonly token: Redacted.Redacted<string> }> => {
  if (cookieHeader === null || cookieHeader === undefined) return [];
  const found = new Map<string, string>();
  for (const segment of cookieHeader.split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 0) continue;
    const slot = slotOf(cookieName, segment.slice(0, separator).trim());
    const value = segment.slice(separator + 1).trim();
    if (slot === undefined || value.length === 0 || found.has(slot)) continue;
    found.set(slot, value);
  }
  return [...found].map(([slot, value]) => ({ slot, token: Redacted.make(value) }));
};

/**
 * The length of a `Cookie` header without its slot cookies: what the
 * session cookie's size guard measures, so that the slots a browser holds
 * never cost it its session.
 */
export const lengthWithoutSlotCookies = (cookieName: string, cookieHeader: string): number =>
  cookieHeader
    .split(";")
    .filter((segment) => !isSlotCookie(cookieName, segment))
    .join(";").length;
