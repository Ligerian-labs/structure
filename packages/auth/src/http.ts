import { Effect, Redacted } from "effect";
import { readBoundedText } from "./body.js";
import {
  AccountLinkDenied,
  type AuthDependencyError,
  AuthValidationError,
  EmailNotVerified,
  IdentityConflict,
  InvalidAuthRoutes,
  InvalidAuthToken,
  InvalidCredentials,
  RateLimitExceeded,
  UnsupportedPasskey,
} from "./errors.js";
import type { OAuthProviderId, TenantId } from "./model.js";
import type { AuthService, AuthServiceError } from "./service.js";
import type { PasskeyAuthenticationResponse, PasskeyRegistrationResponse } from "./webauthn.js";

export interface AuthHandlerOptions {
  readonly resolveTenant: (
    request: Request,
  ) => Effect.Effect<TenantId, AuthDependencyError | AuthValidationError>;
  readonly basePath?: string;
  /**
   * Absolute path overrides for individual routes, keyed by stable route id.
   * An overridden route is served at exactly the given path (its fixed HTTP
   * method unchanged) and leaves the `basePath` namespace; every other route
   * keeps its default `${basePath}/...` path. `oauthStart` and `oauthCallback`
   * overrides must contain exactly one `:provider` segment; all other routes
   * accept literal paths only. Invalid shapes and same-method path collisions
   * fail construction with `InvalidAuthRoutes`.
   */
  readonly routes?: Partial<Record<AuthRouteId, string>>;
  /**
   * Application path used after a successful browser OAuth callback. When set,
   * the callback responds with 303 to the validated `returnTo`, or this path
   * when OAuth started without one. Leave unset to keep the JSON response.
   */
  readonly oauthCallbackRedirect?: string;
  readonly maxBodyBytes?: number;
  readonly allowOrigin?: (
    tenantId: TenantId,
    origin: string,
    request: Request,
  ) => Effect.Effect<boolean, AuthDependencyError>;
}

export interface AuthHandler {
  readonly handler: (request: Request) => Promise<Response>;
  /** The callback URI to register for this handler's compiled route table. */
  readonly authorizationServerRedirectUri: (
    tenantId: TenantId,
    provider: OAuthProviderId,
  ) => Effect.Effect<string, AuthServiceError>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const jsonResponse = (
  status: number,
  body: unknown,
  headers?: Readonly<Record<string, string>>,
): Response =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });

const redirectResponse = (location: string, cookie: string): Response =>
  new Response(null, {
    status: 303,
    headers: {
      "cache-control": "no-store",
      location,
      "set-cookie": cookie,
    },
  });

const decodeBody = (
  request: Request,
  maxBytes: number,
): Effect.Effect<Record<string, unknown>, AuthValidationError> =>
  Effect.gen(function* () {
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > maxBytes) {
      return yield* new AuthValidationError({ field: "body", reason: "is too large" });
    }
    const text = yield* Effect.tryPromise({
      try: () => readBoundedText(request.body, maxBytes),
      catch: () =>
        new AuthValidationError({ field: "body", reason: "could not be read within the limit" }),
    });
    const body = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: () => new AuthValidationError({ field: "body", reason: "must be valid JSON" }),
    });
    return isRecord(body)
      ? body
      : yield* new AuthValidationError({ field: "body", reason: "must be an object" });
  });

const stringField = (
  body: Record<string, unknown>,
  field: string,
  optional = false,
): Effect.Effect<string | undefined, AuthValidationError> => {
  const value = body[field];
  if (value === undefined && optional) return Effect.succeed(undefined);
  return typeof value === "string"
    ? Effect.succeed(value)
    : Effect.fail(new AuthValidationError({ field, reason: "must be a string" }));
};

const requiredString = (
  body: Record<string, unknown>,
  field: string,
): Effect.Effect<string, AuthValidationError> =>
  stringField(body, field).pipe(
    Effect.flatMap((value) =>
      value === undefined
        ? Effect.fail(new AuthValidationError({ field, reason: "is required" }))
        : Effect.succeed(value),
    ),
  );

const stringArray = (
  value: unknown,
  field: string,
): Effect.Effect<ReadonlyArray<string> | undefined, AuthValidationError> => {
  if (value === undefined) return Effect.succeed(undefined);
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? Effect.succeed(value)
    : Effect.fail(new AuthValidationError({ field, reason: "must be an array of strings" }));
};

const registrationResponse = (
  body: Record<string, unknown>,
): Effect.Effect<PasskeyRegistrationResponse, AuthValidationError> =>
  Effect.gen(function* () {
    const credentialId = yield* requiredString(body, "credentialId");
    const response = body.response;
    if (!isRecord(response)) {
      return yield* new AuthValidationError({ field: "response", reason: "must be an object" });
    }
    const transports = yield* stringArray(response.transports, "response.transports");
    return {
      credentialId,
      response: {
        clientDataJSON: yield* requiredString(response, "clientDataJSON"),
        attestationObject: yield* requiredString(response, "attestationObject"),
        ...(transports === undefined ? {} : { transports }),
      },
    };
  });

const authenticationResponse = (
  body: Record<string, unknown>,
): Effect.Effect<PasskeyAuthenticationResponse, AuthValidationError> =>
  Effect.gen(function* () {
    const credentialId = yield* requiredString(body, "credentialId");
    const response = body.response;
    if (!isRecord(response)) {
      return yield* new AuthValidationError({ field: "response", reason: "must be an object" });
    }
    const userHandle = yield* stringField(response, "userHandle", true);
    return {
      credentialId,
      response: {
        clientDataJSON: yield* requiredString(response, "clientDataJSON"),
        authenticatorData: yield* requiredString(response, "authenticatorData"),
        signature: yield* requiredString(response, "signature"),
        ...(userHandle === undefined ? {} : { userHandle }),
      },
    };
  });

const errorResponse = (error: AuthServiceError): Response => {
  if (error instanceof AuthValidationError || error instanceof UnsupportedPasskey) {
    return jsonResponse(400, { error: error._tag, message: error.message });
  }
  if (error instanceof EmailNotVerified || error instanceof AccountLinkDenied) {
    return jsonResponse(403, { error: error._tag, message: error.message });
  }
  if (error instanceof IdentityConflict) {
    return jsonResponse(409, { error: error._tag, message: error.message });
  }
  if (error instanceof RateLimitExceeded) {
    return jsonResponse(
      429,
      { error: error._tag, message: error.message },
      error.retryAfterSeconds === undefined
        ? undefined
        : { "retry-after": String(error.retryAfterSeconds) },
    );
  }
  if (error instanceof InvalidCredentials || error instanceof InvalidAuthToken) {
    return jsonResponse(401, { error: error._tag, message: error.message });
  }
  return jsonResponse(503, { error: "AuthUnavailable", message: "Authentication is unavailable" });
};

const PROVIDER_PARAM = ":provider";
const OAUTH_ROUTES: ReadonlySet<string> = new Set(["oauthStart", "oauthCallback"]);

const AUTH_ROUTE_IDS = [
  "registerPassword",
  "verifyEmail",
  "requestEmailVerification",
  "signInPassword",
  "signOut",
  "getSession",
  "requestPasswordReset",
  "resetPassword",
  "changePassword",
  "requestMagicLink",
  "consumeMagicLink",
  "oauthStart",
  "oauthCallback",
  "passkeyRegisterOptions",
  "passkeyRegisterVerify",
  "passkeyAuthenticateOptions",
  "passkeyAuthenticateVerify",
] as const;

export type AuthRouteId = (typeof AUTH_ROUTE_IDS)[number];

type RouteMethod = "GET" | "POST";

interface CompiledRoute {
  readonly id: AuthRouteId;
  readonly method: RouteMethod;
  readonly segments: ReadonlyArray<string>;
}

export interface AuthRouteViolation {
  readonly route: string;
  readonly reason: string;
}

const DEFAULT_ROUTE_SUFFIXES: Readonly<Record<AuthRouteId, readonly [RouteMethod, string]>> = {
  registerPassword: ["POST", "register/password"],
  verifyEmail: ["POST", "verify-email"],
  requestEmailVerification: ["POST", "email-verification/request"],
  signInPassword: ["POST", "sign-in/password"],
  signOut: ["POST", "sign-out"],
  getSession: ["GET", "session"],
  requestPasswordReset: ["POST", "password/reset/request"],
  resetPassword: ["POST", "password/reset/complete"],
  changePassword: ["POST", "password/change"],
  requestMagicLink: ["POST", "magic-link/request"],
  consumeMagicLink: ["POST", "magic-link/consume"],
  oauthStart: ["POST", `oauth/${PROVIDER_PARAM}/start`],
  oauthCallback: ["GET", `oauth/${PROVIDER_PARAM}/callback`],
  passkeyRegisterOptions: ["POST", "passkeys/register/options"],
  passkeyRegisterVerify: ["POST", "passkeys/register/verify"],
  passkeyAuthenticateOptions: ["POST", "passkeys/authenticate/options"],
  passkeyAuthenticateVerify: ["POST", "passkeys/authenticate/verify"],
};

const isAuthRouteId = (value: string): value is AuthRouteId =>
  (AUTH_ROUTE_IDS as readonly string[]).includes(value);

const overrideSegments = (path: string): ReadonlyArray<string> => path.slice(1).split("/");

const overridePathProblem = (path: string): string | undefined => {
  if (path === "" || !path.startsWith("/")) return "must be a literal path starting with /";
  if (path.includes("?") || path.includes("#")) {
    return "must be a literal path without a query or fragment";
  }
  const segments = overrideSegments(path);
  if (segments.some((segment) => segment.length === 0)) {
    return "must be a literal path without empty segments";
  }
  if (segments.some((segment) => segment.includes(":") && segment !== PROVIDER_PARAM)) {
    return `only the ${PROVIDER_PARAM} parameter segment is supported`;
  }
  return undefined;
};

const patternsOverlap = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
  a.length === b.length &&
  a.every((segment, index) => {
    const other = b[index];
    if (other === undefined) return false;
    return segment === other || segment === PROVIDER_PARAM || other === PROVIDER_PARAM;
  });

const compileRoutes = (
  basePath: string,
  overrides: Partial<Record<AuthRouteId, string>> | undefined,
): {
  readonly routes: ReadonlyArray<CompiledRoute>;
  readonly violations: ReadonlyArray<AuthRouteViolation>;
} => {
  const violations: Array<AuthRouteViolation> = [];
  const overridden = new Map<AuthRouteId, ReadonlyArray<string>>();

  for (const [id, value] of Object.entries(overrides ?? {})) {
    if (!isAuthRouteId(id)) {
      violations.push({ route: id, reason: "is not a known auth route id" });
      continue;
    }
    if (typeof value !== "string") {
      violations.push({ route: id, reason: "override must be a string" });
      continue;
    }
    const problem = overridePathProblem(value);
    if (problem !== undefined) {
      violations.push({ route: id, reason: problem });
      continue;
    }
    const segments = overrideSegments(value);
    const providerCount = segments.filter((segment) => segment === PROVIDER_PARAM).length;
    if (OAUTH_ROUTES.has(id) ? providerCount !== 1 : providerCount !== 0) {
      violations.push({
        route: id,
        reason: OAUTH_ROUTES.has(id)
          ? `must contain exactly one ${PROVIDER_PARAM} segment`
          : `must not contain a ${PROVIDER_PARAM} segment`,
      });
      continue;
    }
    overridden.set(id, segments);
  }

  const baseSegments: ReadonlyArray<string> = basePath
    .split("/")
    .filter((segment) => segment.length > 0);
  const routes: ReadonlyArray<CompiledRoute> = AUTH_ROUTE_IDS.map((id) => {
    const [method, suffix] = DEFAULT_ROUTE_SUFFIXES[id];
    return {
      id,
      method,
      segments: overridden.get(id) ?? [...baseSegments, ...suffix.split("/")],
    };
  });

  for (let i = 0; i < routes.length; i++) {
    for (let j = i + 1; j < routes.length; j++) {
      const first = routes[i];
      const second = routes[j];
      if (first === undefined || second === undefined) continue;
      if (first.method !== second.method || !patternsOverlap(first.segments, second.segments)) {
        continue;
      }
      violations.push({
        route: first.id,
        reason: `path /${first.segments.join("/")} (${first.method}) is claimed by both ${first.id} and ${second.id}`,
      });
    }
  }

  return { routes, violations };
};

const decodeSegment = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

const matchRoute = (
  routes: ReadonlyArray<CompiledRoute>,
  method: string,
  segments: ReadonlyArray<string>,
): { readonly route: CompiledRoute; readonly provider?: string } | undefined => {
  for (const route of routes) {
    if (route.method !== method || route.segments.length !== segments.length) continue;
    let provider: string | undefined;
    let matches = true;
    for (let index = 0; index < route.segments.length; index++) {
      const pattern = route.segments[index];
      const segment = segments[index];
      if (pattern === undefined || segment === undefined) {
        matches = false;
        break;
      }
      if (pattern === PROVIDER_PARAM) {
        provider = segment;
        continue;
      }
      if (pattern !== segment) {
        matches = false;
        break;
      }
    }
    if (matches) return { route, ...(provider === undefined ? {} : { provider }) };
  }
  return undefined;
};

const pathForRoute = (
  routes: ReadonlyArray<CompiledRoute>,
  id: AuthRouteId,
  provider: OAuthProviderId,
): string => {
  const route = routes.find((candidate) => candidate.id === id);
  if (route === undefined) return "/";
  return `/${route.segments
    .map((segment) => (segment === PROVIDER_PARAM ? encodeURIComponent(provider) : segment))
    .join("/")}`;
};

const isApplicationPath = (path: string): boolean => {
  if (!path.startsWith("/")) return false;
  try {
    return new URL(path, "https://auth.invalid").origin === "https://auth.invalid";
  } catch {
    return false;
  }
};

const defaultOrigin = (
  _tenantId: TenantId,
  origin: string,
  request: Request,
): Effect.Effect<boolean> => Effect.succeed(origin === new URL(request.url).origin);

export const makeAuthHandler = (
  auth: AuthService,
  options: AuthHandlerOptions,
): Effect.Effect<AuthHandler, InvalidAuthRoutes> => {
  const basePath = (options.basePath ?? "/auth").replace(/\/$/u, "");
  const maxBodyBytes = options.maxBodyBytes ?? 64 * 1_024;
  const allowOrigin = options.allowOrigin ?? defaultOrigin;
  const compiled = compileRoutes(basePath, options.routes);
  const violations = [...compiled.violations];
  if (
    options.oauthCallbackRedirect !== undefined &&
    !isApplicationPath(options.oauthCallbackRedirect)
  ) {
    violations.push({
      route: "oauthCallbackRedirect",
      reason: "must be an absolute application path starting with one /",
    });
  }
  if (violations.length > 0) {
    return Effect.fail(new InvalidAuthRoutes({ violations }));
  }
  const routes = compiled.routes;
  const authorizationServerRedirectUri = (tenantId: TenantId, provider: OAuthProviderId) =>
    auth.authorizationServerRedirectUri(
      tenantId,
      provider,
      pathForRoute(routes, "oauthCallback", provider),
    );

  const program = (request: Request): Effect.Effect<Response, AuthServiceError> =>
    Effect.gen(function* () {
      const tenantId = yield* options.resolveTenant(request);
      const segments = new URL(request.url).pathname
        .split("/")
        .filter((segment) => segment.length > 0)
        .map(decodeSegment);
      const matched = matchRoute(routes, request.method, segments);
      if (matched === undefined) return jsonResponse(404, { error: "NotFound" });
      const { route, provider } = matched;
      if (request.method !== "GET" && request.method !== "HEAD") {
        const origin = request.headers.get("origin");
        if (origin === null || !(yield* allowOrigin(tenantId, origin, request))) {
          return yield* new AuthValidationError({ field: "origin", reason: "is not allowed" });
        }
      }
      const cookie = yield* auth.sessionTokenFromCookie(tenantId, request.headers.get("cookie"));

      switch (route.id) {
        case "registerPassword": {
          const body = yield* decodeBody(request, maxBodyBytes);
          const email = yield* requiredString(body, "email");
          const password = yield* requiredString(body, "password");
          const displayName = yield* stringField(body, "displayName", true);
          const user = yield* auth.registerPassword({
            tenantId,
            email,
            password,
            ...(displayName === undefined ? {} : { displayName }),
          });
          return jsonResponse(201, { user });
        }
        case "verifyEmail": {
          const body = yield* decodeBody(request, maxBodyBytes);
          const user = yield* auth.verifyEmail(
            tenantId,
            Redacted.make(yield* requiredString(body, "token")),
          );
          return jsonResponse(200, { user });
        }
        case "requestEmailVerification": {
          const body = yield* decodeBody(request, maxBodyBytes);
          yield* auth.requestEmailVerification(tenantId, yield* requiredString(body, "email"));
          return jsonResponse(202, { accepted: true });
        }
        case "signInPassword": {
          const body = yield* decodeBody(request, maxBodyBytes);
          const session = yield* auth.signInPassword(
            tenantId,
            yield* requiredString(body, "email"),
            yield* requiredString(body, "password"),
          );
          return jsonResponse(
            200,
            { user: session.user, expiresAt: session.expiresAt },
            {
              "set-cookie": yield* auth.sessionCookie(tenantId, session),
            },
          );
        }
        case "signOut": {
          if (cookie !== undefined) yield* auth.signOut(tenantId, cookie);
          return jsonResponse(
            200,
            { signedOut: true },
            {
              "set-cookie": yield* auth.sessionCookie(tenantId, undefined),
            },
          );
        }
        case "getSession": {
          if (cookie === undefined) return jsonResponse(200, { session: null });
          const session = yield* auth.getSession(tenantId, cookie);
          return jsonResponse(200, {
            session: { user: session.user, expiresAt: session.expiresAt },
          });
        }
        case "requestPasswordReset": {
          const body = yield* decodeBody(request, maxBodyBytes);
          yield* auth.requestPasswordReset(tenantId, yield* requiredString(body, "email"));
          return jsonResponse(202, { accepted: true });
        }
        case "resetPassword": {
          const body = yield* decodeBody(request, maxBodyBytes);
          const session = yield* auth.resetPassword(
            tenantId,
            Redacted.make(yield* requiredString(body, "token")),
            yield* requiredString(body, "newPassword"),
          );
          return jsonResponse(
            200,
            { user: session.user, expiresAt: session.expiresAt },
            {
              "set-cookie": yield* auth.sessionCookie(tenantId, session),
            },
          );
        }
        case "changePassword": {
          if (cookie === undefined) return yield* new InvalidCredentials({ reason: "session" });
          const body = yield* decodeBody(request, maxBodyBytes);
          const session = yield* auth.changePassword(
            tenantId,
            cookie,
            yield* requiredString(body, "currentPassword"),
            yield* requiredString(body, "newPassword"),
          );
          return jsonResponse(
            200,
            { user: session.user, expiresAt: session.expiresAt },
            {
              "set-cookie": yield* auth.sessionCookie(tenantId, session),
            },
          );
        }
        case "requestMagicLink": {
          const body = yield* decodeBody(request, maxBodyBytes);
          yield* auth.requestMagicLink(tenantId, yield* requiredString(body, "email"));
          return jsonResponse(202, { accepted: true });
        }
        case "consumeMagicLink": {
          const body = yield* decodeBody(request, maxBodyBytes);
          const session = yield* auth.consumeMagicLink(
            tenantId,
            Redacted.make(yield* requiredString(body, "token")),
          );
          return jsonResponse(
            200,
            { user: session.user, expiresAt: session.expiresAt },
            {
              "set-cookie": yield* auth.sessionCookie(tenantId, session),
            },
          );
        }
        case "oauthStart": {
          if (provider === undefined) {
            return yield* new AuthValidationError({ field: "provider", reason: "is required" });
          }
          const body = yield* decodeBody(request, maxBodyBytes);
          const returnTo = yield* stringField(body, "returnTo", true);
          const redirectTo = returnTo ?? options.oauthCallbackRedirect;
          return jsonResponse(
            200,
            yield* auth.beginOAuth(tenantId, provider, {
              ...(redirectTo === undefined ? {} : { returnTo: redirectTo }),
              callbackPath: pathForRoute(routes, "oauthCallback", provider),
            }),
          );
        }
        case "oauthCallback": {
          if (provider === undefined) {
            return yield* new AuthValidationError({ field: "provider", reason: "is required" });
          }
          const url = new URL(request.url);
          const state = url.searchParams.get("state");
          const code = url.searchParams.get("code");
          if (state === null || code === null) {
            return yield* new AuthValidationError({
              field: "oauth",
              reason: "state and code are required",
            });
          }
          const completed = yield* auth.completeOAuth({
            tenantId,
            provider,
            state: Redacted.make(state),
            code: Redacted.make(code),
            ...(cookie === undefined ? {} : { currentSessionToken: cookie }),
          });
          const sessionCookie = yield* auth.sessionCookie(tenantId, completed.session);
          if (options.oauthCallbackRedirect !== undefined) {
            const location =
              completed.returnTo ??
              new URL(
                options.oauthCallbackRedirect,
                yield* authorizationServerRedirectUri(tenantId, provider),
              ).toString();
            return redirectResponse(location, sessionCookie);
          }
          return jsonResponse(
            200,
            { user: completed.session.user, returnTo: completed.returnTo },
            {
              "set-cookie": sessionCookie,
            },
          );
        }
        case "passkeyRegisterOptions": {
          if (cookie === undefined) return yield* new InvalidCredentials({ reason: "session" });
          return jsonResponse(200, yield* auth.beginPasskeyRegistration(tenantId, cookie));
        }
        case "passkeyRegisterVerify": {
          if (cookie === undefined) return yield* new InvalidCredentials({ reason: "session" });
          const body = yield* decodeBody(request, maxBodyBytes);
          yield* auth.finishPasskeyRegistration(
            tenantId,
            cookie,
            yield* registrationResponse(body),
          );
          return jsonResponse(200, { registered: true });
        }
        case "passkeyAuthenticateOptions": {
          const body = yield* decodeBody(request, maxBodyBytes);
          const email = yield* stringField(body, "email", true);
          return jsonResponse(200, yield* auth.beginPasskeyAuthentication(tenantId, email));
        }
        case "passkeyAuthenticateVerify": {
          const body = yield* decodeBody(request, maxBodyBytes);
          const session = yield* auth.finishPasskeyAuthentication(
            tenantId,
            yield* authenticationResponse(body),
          );
          return jsonResponse(
            200,
            { user: session.user, expiresAt: session.expiresAt },
            {
              "set-cookie": yield* auth.sessionCookie(tenantId, session),
            },
          );
        }
      }
      return jsonResponse(404, { error: "NotFound" });
    });

  return Effect.succeed({
    authorizationServerRedirectUri,
    handler: (request) =>
      Effect.runPromise(
        program(request).pipe(
          Effect.catchAll((error) => Effect.succeed(errorResponse(error))),
          Effect.catchAllCause(() =>
            Effect.succeed(
              jsonResponse(500, {
                error: "AuthInternalError",
                message: "Authentication failed unexpectedly",
              }),
            ),
          ),
        ),
      ),
  });
};
