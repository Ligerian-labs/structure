import { Effect, Redacted } from "effect";
import { readBoundedText } from "./body.js";
import {
  AccountLinkDenied,
  type AuthDependencyError,
  AuthValidationError,
  EmailNotVerified,
  IdentityConflict,
  InvalidAuthToken,
  InvalidCredentials,
  RateLimitExceeded,
  UnsupportedPasskey,
} from "./errors.js";
import type { TenantId } from "./model.js";
import type { AuthService, AuthServiceError } from "./service.js";
import type { PasskeyAuthenticationResponse, PasskeyRegistrationResponse } from "./webauthn.js";

export interface AuthHandlerOptions {
  readonly resolveTenant: (
    request: Request,
  ) => Effect.Effect<TenantId, AuthDependencyError | AuthValidationError>;
  readonly basePath?: string;
  readonly maxBodyBytes?: number;
  readonly allowOrigin?: (
    tenantId: TenantId,
    origin: string,
    request: Request,
  ) => Effect.Effect<boolean, AuthDependencyError>;
}

export interface AuthHandler {
  readonly handler: (request: Request) => Promise<Response>;
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

const routeParts = (pathname: string, basePath: string): ReadonlyArray<string> | undefined => {
  if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) return undefined;
  return pathname
    .slice(basePath.length)
    .split("/")
    .filter((part) => part.length > 0)
    .map(decodeURIComponent);
};

const defaultOrigin = (
  _tenantId: TenantId,
  origin: string,
  request: Request,
): Effect.Effect<boolean> => Effect.succeed(origin === new URL(request.url).origin);

export const makeAuthHandler = (auth: AuthService, options: AuthHandlerOptions): AuthHandler => {
  const basePath = (options.basePath ?? "/auth").replace(/\/$/u, "");
  const maxBodyBytes = options.maxBodyBytes ?? 64 * 1_024;
  const allowOrigin = options.allowOrigin ?? defaultOrigin;

  const program = (request: Request): Effect.Effect<Response, AuthServiceError> =>
    Effect.gen(function* () {
      const tenantId = yield* options.resolveTenant(request);
      const parts = routeParts(new URL(request.url).pathname, basePath);
      if (parts === undefined) return jsonResponse(404, { error: "NotFound" });
      const isOAuthCallback =
        request.method === "GET" && parts[0] === "oauth" && parts[2] === "callback";
      if (request.method !== "GET" && request.method !== "HEAD") {
        const origin = request.headers.get("origin");
        if (origin === null || !(yield* allowOrigin(tenantId, origin, request))) {
          return yield* new AuthValidationError({ field: "origin", reason: "is not allowed" });
        }
      }
      const cookie = yield* auth.sessionTokenFromCookie(tenantId, request.headers.get("cookie"));

      if (request.method === "POST" && parts.join("/") === "register/password") {
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
      if (request.method === "POST" && parts.join("/") === "verify-email") {
        const body = yield* decodeBody(request, maxBodyBytes);
        const user = yield* auth.verifyEmail(
          tenantId,
          Redacted.make(yield* requiredString(body, "token")),
        );
        return jsonResponse(200, { user });
      }
      if (request.method === "POST" && parts.join("/") === "email-verification/request") {
        const body = yield* decodeBody(request, maxBodyBytes);
        yield* auth.requestEmailVerification(tenantId, yield* requiredString(body, "email"));
        return jsonResponse(202, { accepted: true });
      }
      if (request.method === "POST" && parts.join("/") === "sign-in/password") {
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
      if (request.method === "POST" && parts.join("/") === "sign-out") {
        if (cookie !== undefined) yield* auth.signOut(tenantId, cookie);
        return jsonResponse(
          200,
          { signedOut: true },
          {
            "set-cookie": yield* auth.sessionCookie(tenantId, undefined),
          },
        );
      }
      if (request.method === "GET" && parts.join("/") === "session") {
        if (cookie === undefined) return jsonResponse(200, { session: null });
        const session = yield* auth.getSession(tenantId, cookie);
        return jsonResponse(200, { session: { user: session.user, expiresAt: session.expiresAt } });
      }
      if (request.method === "POST" && parts.join("/") === "password/reset/request") {
        const body = yield* decodeBody(request, maxBodyBytes);
        yield* auth.requestPasswordReset(tenantId, yield* requiredString(body, "email"));
        return jsonResponse(202, { accepted: true });
      }
      if (request.method === "POST" && parts.join("/") === "password/reset/complete") {
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
      if (request.method === "POST" && parts.join("/") === "password/change") {
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
      if (request.method === "POST" && parts.join("/") === "magic-link/request") {
        const body = yield* decodeBody(request, maxBodyBytes);
        yield* auth.requestMagicLink(tenantId, yield* requiredString(body, "email"));
        return jsonResponse(202, { accepted: true });
      }
      if (request.method === "POST" && parts.join("/") === "magic-link/consume") {
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
      if (request.method === "POST" && parts[0] === "oauth" && parts[2] === "start") {
        const provider = parts[1];
        if (provider === undefined) {
          return yield* new AuthValidationError({ field: "provider", reason: "is required" });
        }
        const body = yield* decodeBody(request, maxBodyBytes);
        const returnTo = yield* stringField(body, "returnTo", true);
        return jsonResponse(200, yield* auth.beginOAuth(tenantId, provider, returnTo));
      }
      if (isOAuthCallback) {
        const provider = parts[1];
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
        return jsonResponse(
          200,
          { user: completed.session.user, returnTo: completed.returnTo },
          {
            "set-cookie": yield* auth.sessionCookie(tenantId, completed.session),
          },
        );
      }
      if (request.method === "POST" && parts.join("/") === "passkeys/register/options") {
        if (cookie === undefined) return yield* new InvalidCredentials({ reason: "session" });
        return jsonResponse(200, yield* auth.beginPasskeyRegistration(tenantId, cookie));
      }
      if (request.method === "POST" && parts.join("/") === "passkeys/register/verify") {
        if (cookie === undefined) return yield* new InvalidCredentials({ reason: "session" });
        const body = yield* decodeBody(request, maxBodyBytes);
        yield* auth.finishPasskeyRegistration(tenantId, cookie, yield* registrationResponse(body));
        return jsonResponse(200, { registered: true });
      }
      if (request.method === "POST" && parts.join("/") === "passkeys/authenticate/options") {
        const body = yield* decodeBody(request, maxBodyBytes);
        const email = yield* stringField(body, "email", true);
        return jsonResponse(200, yield* auth.beginPasskeyAuthentication(tenantId, email));
      }
      if (request.method === "POST" && parts.join("/") === "passkeys/authenticate/verify") {
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
      return jsonResponse(404, { error: "NotFound" });
    });

  return {
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
  };
};
