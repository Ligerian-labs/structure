import { describe, expect, test } from "bun:test";
import { Effect, Redacted } from "effect";
import {
  type AuthEmail,
  type AuthHandler,
  type AuthService,
  type AuthSession,
  AuthValidationError,
  allowAllRateLimiter,
  argon2id,
  inMemoryAuthStore,
  makeAuth,
  makeAuthHandler,
  requestedSlot,
  SESSION_SLOT_HEADER,
  SESSION_SLOT_QUERY,
  SLOT_PATTERN,
  slotCookieName,
  slotCookiesOf,
  type TenantAuthConfig,
} from "../src/index.js";

/**
 * Session slots: several sessions in one browser. A request naming a slot
 * (`x-session-slot`, or `?session_slot=` on GET and HEAD) is served by the
 * slot's cookie `<cookieName>.<slot>` alone; the session held in slot S
 * serves subject S or nobody; a request naming no slot is served exactly as
 * before, by the usual cookie alone.
 */

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const fail = <A, E>(effect: Effect.Effect<A, E>) => run(Effect.flip(effect));

const select = (method: string, headers: Record<string, string>, url = "/files/1") =>
  requestedSlot({ method, headers, url });

describe("session slots: the selector", () => {
  test("names the header first, the query on GET and HEAD only, and nothing when both are absent or blank", () => {
    expect(select("GET", {})).toEqual({ _tag: "none" });
    expect(select("GET", { [SESSION_SLOT_HEADER]: "  ada_1-x  " })).toEqual({
      _tag: "slot",
      slot: "ada_1-x",
    });
    expect(select("GET", { [SESSION_SLOT_HEADER]: "   " })).toEqual({ _tag: "none" });
    expect(select("GET", {}, `/files/1?${SESSION_SLOT_QUERY}=`)).toEqual({ _tag: "none" });
    for (const method of ["GET", "HEAD", "get"]) {
      expect(select(method, {}, `/files/1?${SESSION_SLOT_QUERY}=bob`)).toEqual({
        _tag: "slot",
        slot: "bob",
      });
    }
    // A write's query parameter names nothing; its header does.
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(select(method, {}, `/files/1?${SESSION_SLOT_QUERY}=bob`)).toEqual({ _tag: "none" });
      expect(
        select(method, { [SESSION_SLOT_HEADER]: "ada" }, `/files/1?${SESSION_SLOT_QUERY}=bob`),
      ).toEqual({ _tag: "slot", slot: "ada" });
    }
    // Absolute or path-and-query alike; a fragment is no query.
    expect(
      select("GET", {}, `https://app.example.com/files/1?${SESSION_SLOT_QUERY}=bob#x`),
    ).toEqual({ _tag: "slot", slot: "bob" });
    expect(select("GET", {}, `/files/1#?${SESSION_SLOT_QUERY}=bob`)).toEqual({ _tag: "none" });
  });

  test("never guesses: a header and a query that disagree, two query values that disagree, or a value outside the pattern are invalid", () => {
    expect(
      select("GET", { [SESSION_SLOT_HEADER]: "bob" }, `/files/1?${SESSION_SLOT_QUERY}=bob`),
    ).toEqual({ _tag: "slot", slot: "bob" });
    expect(
      select("GET", { [SESSION_SLOT_HEADER]: "ada" }, `/files/1?${SESSION_SLOT_QUERY}=bob`),
    ).toEqual({ _tag: "invalid" });
    expect(
      select("HEAD", {}, `/files/1?${SESSION_SLOT_QUERY}=ada&${SESSION_SLOT_QUERY}=bob`),
    ).toEqual({ _tag: "invalid" });
    expect(
      select("GET", {}, `/files/1?${SESSION_SLOT_QUERY}=ada&${SESSION_SLOT_QUERY}=ada`),
    ).toEqual({ _tag: "slot", slot: "ada" });

    expect(SLOT_PATTERN.test("AbC-_09")).toBe(true);
    expect(select("GET", { [SESSION_SLOT_HEADER]: "a".repeat(128) })).toEqual({
      _tag: "slot",
      slot: "a".repeat(128),
    });
    for (const value of ["a;b", "a".repeat(129), "a.b", "é", "a b", "a=b", "a,b"]) {
      expect(select("GET", { [SESSION_SLOT_HEADER]: value }), value).toEqual({ _tag: "invalid" });
      expect(
        select("GET", {}, `/files/1?${SESSION_SLOT_QUERY}=${encodeURIComponent(value)}`),
        value,
      ).toEqual({ _tag: "invalid" });
    }
  });

  test("reads a Web Request as it is, and a record of lower-cased headers", () => {
    const web = new Request(`https://app.example.com/files/1?${SESSION_SLOT_QUERY}=bob`, {
      headers: { "X-Session-Slot": "bob" },
    });
    expect(requestedSlot(web)).toEqual({ _tag: "slot", slot: "bob" });
    expect(
      requestedSlot({ method: "POST", headers: { [SESSION_SLOT_HEADER]: "ada" }, url: "/x" }),
    ).toEqual({ _tag: "slot", slot: "ada" });
  });
});

describe("session slots: the cookies", () => {
  test("a slot's cookie is named after the session cookie", () => {
    expect(slotCookieName("tenant_session", "ada")).toBe("tenant_session.ada");
  });

  test("lists every slot cookie once, in the header's order, its token redacted; anything else is not a slot cookie", () => {
    const header = [
      "tenant_session=main",
      "tenant_session.B=",
      "tenant_session.A=one",
      "theme=dark",
      "tenant_session.B=two",
      "tenant_session.A=three",
      "tenant_sessionx.C=lookalike",
      "tenant_session.a.b=no-valid-slot",
      "other_session.D=another-cookie",
    ].join("; ");
    const slots = slotCookiesOf("tenant_session", header);
    expect(slots.map(({ slot, token }) => [slot, Redacted.value(token)])).toEqual([
      ["A", "one"],
      ["B", "two"],
    ]);
    expect(String(slots[0]?.token)).not.toContain("one");
    expect(slotCookiesOf("tenant_session", null)).toEqual([]);
    expect(slotCookiesOf("tenant_session", undefined)).toEqual([]);
  });
});

describe("session slots: the service", () => {
  const now = new Date("2026-11-04T12:00:00.000Z");
  const auth = makeAuth({
    store: inMemoryAuthStore().store,
    resolveTenant: () =>
      Effect.succeed({
        baseUrl: new URL("https://accounts.example.com"),
        session: {
          cookieName: "app_session",
          cookiePath: "/app",
          cookieDomain: "example.com",
          cookieSameSite: "Strict",
        },
      }),
    emailSender: { send: () => Effect.void },
    rateLimiter: allowAllRateLimiter,
    primitives: { now: () => now },
  });
  const session: AuthSession = {
    token: Redacted.make("token-1"),
    user: {
      id: "user-1",
      tenantId: "tenant-a",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    },
    expiresAt: new Date(now.getTime() + 60_000),
  };
  const pairOf = (setCookie: string) => setCookie.slice(0, setCookie.indexOf(";"));
  const attributesOf = (setCookie: string) => setCookie.slice(setCookie.indexOf(";"));
  const read = async (cookieHeader: string | null, slot?: string) => {
    const token = await run(
      auth.sessionTokenFromCookie("tenant-a", cookieHeader, slot === undefined ? {} : { slot }),
    );
    return token === undefined ? undefined : Redacted.value(token);
  };

  test("writes a slot's cookie with exactly the usual cookie's attributes, and clears it the same way", async () => {
    const usual = await run(auth.sessionCookie("tenant-a", session));
    const slotted = await run(auth.sessionCookie("tenant-a", session, { slot: "user-1" }));
    expect(slotted).toBe(
      "app_session.user-1=token-1; Path=/app; HttpOnly; SameSite=Strict; Secure; Max-Age=60; Domain=example.com",
    );
    expect(pairOf(usual)).toBe("app_session=token-1");
    expect(attributesOf(slotted)).toBe(attributesOf(usual));

    const cleared = await run(auth.sessionCookie("tenant-a", undefined));
    const slotCleared = await run(auth.sessionCookie("tenant-a", undefined, { slot: "user-1" }));
    expect(pairOf(slotCleared)).toBe("app_session.user-1=");
    expect(attributesOf(slotCleared)).toBe(attributesOf(cleared));
    expect(slotCleared).toContain("Max-Age=0");
    // No slot named: the usual cookie, as before.
    expect(await run(auth.sessionCookie("tenant-a", session, {}))).toBe(usual);
  });

  test("refuses a slot outside the pattern, which would land in a cookie name", async () => {
    for (const slot of ["", "a;b", "a\r\nset-cookie: x=y", "a.b", "a".repeat(129)]) {
      const written = await fail(auth.sessionCookie("tenant-a", session, { slot }));
      expect(written).toBeInstanceOf(AuthValidationError);
      expect((written as AuthValidationError).field).toBe("slot");
      expect(
        await fail(auth.sessionTokenFromCookie("tenant-a", "app_session=main", { slot })),
      ).toBeInstanceOf(AuthValidationError);
    }
  });

  test("a slot reads its own cookie only, never the usual one; no slot reads the usual cookie only", async () => {
    const header =
      "app_session=main; theme=dark; app_session.ada=; app_session.ada=ada-token; app_session.bob=bob-token";
    expect(await read(header)).toBe("main");
    expect(await read(header, "ada")).toBe("ada-token");
    expect(await read(header, "bob")).toBe("bob-token");
    // Never a fall back to the usual cookie.
    expect(await read(header, "carol")).toBeUndefined();
    expect(await read("app_session=main", "ada")).toBeUndefined();
    expect(await read(null, "ada")).toBeUndefined();
    // A request naming no slot never reads a slot's cookie.
    expect(await read("app_session.ada=ada-token")).toBeUndefined();
  });

  test("the 16 KiB guard leaves the slot cookies out of its measure, and still counts every other cookie", async () => {
    const many = (name: (index: number) => string) =>
      Array.from({ length: 200 }, (_, index) => `${name(index)}=${"t".repeat(100)}`);
    const withSlots = ["app_session=main", ...many((index) => `app_session.slot-${index}`)].join(
      "; ",
    );
    expect(withSlots.length).toBeGreaterThan(16_384);
    expect(await read(withSlots)).toBe("main");
    expect(await read(withSlots, "slot-199")).toBe("t".repeat(100));

    // Unchanged for every other cookie, a lookalike of a slot cookie included.
    for (const others of [
      many((index) => `pad-${index}`),
      many((index) => `other_session.slot-${index}`),
      many((index) => `app_session.not.a-slot-${index}`),
    ]) {
      const padded = ["app_session=main", ...others].join("; ");
      expect(padded.length).toBeGreaterThan(16_384);
      expect(await read(padded)).toBeUndefined();
      expect(await read(`${padded}; app_session.ada=ada-token`, "ada")).toBeUndefined();
    }
  });
});

const BASE = "https://accounts.example.com";
const COOKIE = "tenant_session";
const PASSWORD = "a long application-approved password";

const setCookies = (response: Response): ReadonlyArray<string> => response.headers.getSetCookie();
const pairOf = (setCookie: string): string => setCookie.split(";")[0]?.trim() ?? "";
const tokenOf = (pair: string): string => pair.slice(pair.indexOf("=") + 1);

interface Call {
  readonly cookie?: string;
  readonly slot?: string;
  readonly body?: unknown;
}

const call = (http: AuthHandler, method: "GET" | "POST", path: string, options: Call = {}) =>
  http.handler(
    new Request(`${BASE}${path}`, {
      method,
      headers: {
        ...(method === "POST" ? { "content-type": "application/json", origin: BASE } : {}),
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
        ...(options.slot === undefined ? {} : { [SESSION_SLOT_HEADER]: options.slot }),
      },
      ...(method === "POST" ? { body: JSON.stringify(options.body ?? {}) } : {}),
    }),
  );

const stack = async (override: (auth: AuthService) => AuthService = (auth) => auth) => {
  const emails: Array<AuthEmail> = [];
  const now = new Date();
  const config: TenantAuthConfig = {
    baseUrl: new URL(BASE),
    session: { cookieName: COOKIE },
    passkey: { rpId: "accounts.example.com", rpName: "Example", origins: [BASE] },
    oauth: { google: { clientId: "google-a", clientSecret: Redacted.make("google-s") } },
  };
  const auth = makeAuth({
    store: inMemoryAuthStore().store,
    resolveTenant: () => Effect.succeed(config),
    emailSender: { send: (email) => Effect.sync(() => emails.push(email)).pipe(Effect.asVoid) },
    rateLimiter: allowAllRateLimiter,
    passwordHasher: argon2id({ memoryCostKiB: 19_456, timeCost: 2 }),
    primitives: { now: () => now },
    oauthHttpClient: {
      execute: (request) =>
        Effect.succeed(
          request.method === "POST"
            ? Response.json({ access_token: "provider-access-token", token_type: "Bearer" })
            : Response.json({
                sub: "erin-subject",
                email: "erin@example.com",
                email_verified: true,
              }),
        ),
    },
  });
  const http = await run(
    makeAuthHandler(override(auth), { resolveTenant: () => Effect.succeed("tenant-a") }),
  );
  const lastToken = (): string => {
    const email = emails.at(-1);
    if (email === undefined) throw new Error("no email was captured");
    return Redacted.value(email.token);
  };
  /** Signs `email` in by magic link, naming `slot` when given. */
  const signIn = async (email: string, slot?: string) => {
    await call(http, "POST", "/auth/magic-link/request", { body: { email } });
    const response = await call(http, "POST", "/auth/magic-link/consume", {
      body: { token: lastToken() },
      ...(slot === undefined ? {} : { slot }),
    });
    expect(response.status).toBe(200);
    const written = setCookies(response);
    expect(written).toHaveLength(1);
    const body = (await response.json()) as { readonly user: { readonly id: string } };
    return { id: body.user.id, setCookie: written[0] ?? "", pair: pairOf(written[0] ?? "") };
  };
  /** The subject the session route answers for this jar, naming `slot` when given. */
  const whoIs = async (cookie: string, slot?: string) => {
    const response = await call(http, "GET", "/auth/session", {
      cookie,
      ...(slot === undefined ? {} : { slot }),
    });
    if (response.status !== 200) return { status: response.status, id: null };
    const body = (await response.json()) as {
      readonly session: { readonly user: { readonly id: string } } | null;
    };
    return { status: 200, id: body.session?.user.id ?? null };
  };
  /** The usual cookie of the first, and one slot each for the two others, all in one jar. */
  const threePeople = async () => {
    const ada = await signIn("ada@example.com");
    const bobId = (await signIn("bob@example.com")).id;
    const carolId = (await signIn("carol@example.com")).id;
    const bob = await signIn("bob@example.com", bobId);
    const carol = await signIn("carol@example.com", carolId);
    return { ada, bob, carol, jar: [ada.pair, bob.pair, carol.pair].join("; ") };
  };
  return { auth, http, emails, lastToken, signIn, whoIs, threePeople };
};

describe("session slots over the auth routes", () => {
  test("a sign-in naming a slot writes the slot's cookie alone, with the usual cookie's attributes", async () => {
    const s = await stack();
    const usual = await s.signIn("bob@example.com");
    expect(usual.pair.startsWith(`${COOKIE}=`)).toBe(true);
    const tab = await s.signIn("bob@example.com", usual.id);
    expect(tab.pair.startsWith(`${slotCookieName(COOKIE, usual.id)}=`)).toBe(true);
    expect(tab.setCookie.slice(tab.setCookie.indexOf(";"))).toBe(
      usual.setCookie.slice(usual.setCookie.indexOf(";")),
    );
  });

  test("one browser, three people: each request is the person its slot names, the usual cookie's when it names none", async () => {
    const s = await stack();
    const { ada, bob, carol, jar } = await s.threePeople();
    expect(await s.whoIs(jar)).toEqual({ status: 200, id: ada.id });
    expect(await s.whoIs(jar, bob.id)).toEqual({ status: 200, id: bob.id });
    expect(await s.whoIs(jar, carol.id)).toEqual({ status: 200, id: carol.id });
    // The query names the slot on a GET: the addresses a browser loads by itself.
    const viaQuery = await call(s.http, "GET", `/auth/session?${SESSION_SLOT_QUERY}=${carol.id}`, {
      cookie: jar,
    });
    expect(await viaQuery.json()).toEqual({
      session: expect.objectContaining({ user: expect.objectContaining({ id: carol.id }) }),
    });
  });

  test("a slot whose cookie is absent is no session, never a fall back to the usual cookie", async () => {
    const s = await stack();
    const ada = await s.signIn("ada@example.com");
    const bobId = (await s.signIn("bob@example.com")).id;
    expect(await s.whoIs(ada.pair, bobId)).toEqual({ status: 200, id: null });
    // And a request naming no slot never sees a slot's cookie.
    const bob = await s.signIn("bob@example.com", bobId);
    expect(await s.whoIs(bob.pair)).toEqual({ status: 200, id: null });
  });

  test("a slot cookie holding another subject's session is no session: the session route answers none, a session route refuses it, a sign-out revokes nobody's", async () => {
    const s = await stack();
    const { ada, bob, carol } = await s.threePeople();
    const tampered = `${slotCookieName(COOKIE, bob.id)}=${tokenOf(carol.pair)}`;
    const jar = [ada.pair, tampered, carol.pair].join("; ");
    expect(await s.whoIs(jar, bob.id)).toEqual({ status: 200, id: null });

    const refused = await call(s.http, "POST", "/auth/passkeys/register/options", {
      cookie: jar,
      slot: bob.id,
    });
    expect(refused.status).toBe(401);
    // The same token under its own slot is Carol's session.
    const own = await call(s.http, "POST", "/auth/passkeys/register/options", {
      cookie: jar,
      slot: carol.id,
    });
    expect(own.status).toBe(200);

    const out = await call(s.http, "POST", "/auth/sign-out", { cookie: jar, slot: bob.id });
    expect(out.status).toBe(200);
    expect(setCookies(out).map(pairOf)).toEqual([`${slotCookieName(COOKIE, bob.id)}=`]);
    expect(await s.whoIs(jar, carol.id)).toEqual({ status: 200, id: carol.id });
    expect(await s.whoIs(jar)).toEqual({ status: 200, id: ada.id });
  });

  test("a sign-out naming a slot ends that slot's session and clears its cookie alone; the usual cookie and the other slots live on", async () => {
    const s = await stack();
    const { ada, bob, carol, jar } = await s.threePeople();
    const out = await call(s.http, "POST", "/auth/sign-out", { cookie: jar, slot: bob.id });
    expect(out.status).toBe(200);
    expect(setCookies(out)).toEqual([
      `${slotCookieName(COOKIE, bob.id)}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`,
    ]);
    // Bob's session is over even where his cookie is still sent; nobody else's is.
    expect(await s.whoIs(jar, bob.id)).toEqual({ status: 401, id: null });
    expect(await s.whoIs(jar, carol.id)).toEqual({ status: 200, id: carol.id });
    expect(await s.whoIs(jar)).toEqual({ status: 200, id: ada.id });
  });

  test("every route that writes a session writes the named slot's cookie, never the usual one", async () => {
    const s = await stack((auth) => ({
      ...auth,
      // The WebAuthn ceremony has its own suite: here, the route's cookie.
      finishPasskeyAuthentication: (tenantId) =>
        Effect.gen(function* () {
          yield* auth.requestMagicLink(tenantId, "dan@example.com");
          return yield* auth.consumeMagicLink(tenantId, Redacted.make(s.lastToken()));
        }),
    }));
    const dan = await run(
      s.auth.registerPassword({
        tenantId: "tenant-a",
        email: "dan@example.com",
        password: PASSWORD,
      }),
    );
    await run(s.auth.verifyEmail("tenant-a", Redacted.make(s.lastToken())));
    const writes = async (response: Response, slot: string) => {
      expect(response.status).toBe(200);
      const written = setCookies(response).map(pairOf);
      expect(written).toHaveLength(1);
      expect(written[0]?.startsWith(`${slotCookieName(COOKIE, slot)}=`)).toBe(true);
      expect(tokenOf(written[0] ?? "").length).toBeGreaterThan(20);
      return written[0] ?? "";
    };

    const signedIn = await writes(
      await call(s.http, "POST", "/auth/sign-in/password", {
        slot: dan.id,
        body: { email: "dan@example.com", password: PASSWORD },
      }),
      dan.id,
    );
    await writes(
      await call(s.http, "POST", "/auth/password/change", {
        slot: dan.id,
        cookie: signedIn,
        body: { currentPassword: PASSWORD, newPassword: `${PASSWORD} again` },
      }),
      dan.id,
    );
    await run(s.auth.requestPasswordReset("tenant-a", "dan@example.com"));
    await writes(
      await call(s.http, "POST", "/auth/password/reset/complete", {
        slot: dan.id,
        body: { token: s.lastToken(), newPassword: `${PASSWORD} once more` },
      }),
      dan.id,
    );
    await run(s.auth.requestMagicLink("tenant-a", "dan@example.com"));
    await writes(
      await call(s.http, "POST", "/auth/magic-link/consume", {
        slot: dan.id,
        body: { token: s.lastToken() },
      }),
      dan.id,
    );
    await writes(
      await call(s.http, "POST", "/auth/passkeys/authenticate/verify", {
        slot: dan.id,
        body: {
          credentialId: "credential",
          response: { clientDataJSON: "c", authenticatorData: "a", signature: "s" },
        },
      }),
      dan.id,
    );

    // The OAuth callback is a GET: a browser coming back names its slot in the query.
    const oauthCallback = async (query: string) => {
      const started = await call(s.http, "POST", "/auth/oauth/google/start");
      const { authorizationUrl } = (await started.json()) as { readonly authorizationUrl: string };
      const state = new URL(authorizationUrl).searchParams.get("state") ?? "";
      return call(
        s.http,
        "GET",
        `/auth/oauth/google/callback?state=${encodeURIComponent(state)}&code=provider-code${query}`,
      );
    };
    const first = await oauthCallback("");
    const erin = ((await first.json()) as { readonly user: { readonly id: string } }).user;
    await writes(await oauthCallback(`&${SESSION_SLOT_QUERY}=${erin.id}`), erin.id);
  });

  test("a write's query parameter names no slot: the sign-in and the sign-out act on the usual cookie", async () => {
    const s = await stack();
    const ada = await s.signIn("ada@example.com");
    await call(s.http, "POST", "/auth/magic-link/request", { body: { email: "ada@example.com" } });
    const consumed = await call(
      s.http,
      "POST",
      `/auth/magic-link/consume?${SESSION_SLOT_QUERY}=${ada.id}`,
      { body: { token: s.lastToken() } },
    );
    expect(consumed.status).toBe(200);
    expect(setCookies(consumed).map((value) => pairOf(value).split("=")[0])).toEqual([COOKIE]);

    const tab = await s.signIn("ada@example.com", ada.id);
    const jar = `${ada.pair}; ${tab.pair}`;
    const out = await call(s.http, "POST", `/auth/sign-out?${SESSION_SLOT_QUERY}=${ada.id}`, {
      cookie: jar,
    });
    expect(setCookies(out).map(pairOf)).toEqual([`${COOKIE}=`]);
    expect(await s.whoIs(jar)).toEqual({ status: 401, id: null });
    expect(await s.whoIs(jar, ada.id)).toEqual({ status: 200, id: ada.id });
  });

  test("a slot the request cannot be served under is 400 invalid_session_slot on any route, and nothing happens", async () => {
    const s = await stack();
    const ada = await s.signIn("ada@example.com");
    const sent = s.emails.length;
    const refusals = [
      await call(s.http, "GET", "/auth/session", { cookie: ada.pair, slot: "a;b" }),
      await call(s.http, "GET", "/auth/session", { cookie: ada.pair, slot: "a".repeat(129) }),
      await call(s.http, "GET", `/auth/session?${SESSION_SLOT_QUERY}=bob`, {
        cookie: ada.pair,
        slot: "carol",
      }),
      await call(
        s.http,
        "GET",
        `/auth/session?${SESSION_SLOT_QUERY}=bob&${SESSION_SLOT_QUERY}=carol`,
        { cookie: ada.pair },
      ),
      await call(s.http, "GET", `/auth/session?${SESSION_SLOT_QUERY}=a.b`, { cookie: ada.pair }),
      await call(s.http, "POST", "/auth/sign-out", { cookie: ada.pair, slot: "a b" }),
      await call(s.http, "POST", "/auth/magic-link/request", {
        slot: "a,b",
        body: { email: "ada@example.com" },
      }),
    ];
    for (const refused of refusals) {
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({
        error: "invalid_session_slot",
        message: "The session slot named by this request is not valid",
      });
      expect(setCookies(refused)).toEqual([]);
    }
    expect(s.emails.length).toBe(sent);
    expect(await s.whoIs(ada.pair)).toEqual({ status: 200, id: ada.id });
  });
});
