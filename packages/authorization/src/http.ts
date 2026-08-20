import * as HttpApiBuilder from "@effect/platform/HttpApiBuilder";
import type * as HttpApp from "@effect/platform/HttpApp";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import { Effect, type Layer, Option, type Scope } from "effect";
import type { PermissionDenied, Unauthenticated } from "./errors.js";
import type { CheckOptions, Policy } from "./policy.js";
import { Principal } from "./principal.js";

/**
 * Turns an incoming request into the acting principal. The application owns
 * this: verify the session/token/API key with its authentication, look the
 * user's roles up, return `Option.none()` for anonymous traffic. Failures
 * (`E`) are the application's to render.
 */
export type PrincipalResolver<E = never, R = never> = (
  request: HttpServerRequest.HttpServerRequest,
) => Effect.Effect<Option.Option<Principal>, E, R>;

/** The token of an `Authorization: Bearer <token>` header, if well-formed. */
export const bearerToken = (
  request: HttpServerRequest.HttpServerRequest,
): Option.Option<string> => {
  const header = request.headers.authorization;
  if (header === undefined) return Option.none();
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] === undefined ? Option.none() : Option.some(match[1]);
};

/** A resolver over bearer tokens: requests without a usable header are anonymous. */
export const fromBearer =
  <E, R>(
    lookup: (token: string) => Effect.Effect<Option.Option<Principal>, E, R>,
  ): PrincipalResolver<E, R> =>
  (request) =>
    Option.match(bearerToken(request), {
      onNone: () => Effect.succeed(Option.none()),
      onSome: lookup,
    });

/**
 * Request middleware: resolves the principal once and runs the rest of the
 * request on its behalf (`Principal.within`), so guards below — in handlers,
 * on the CQRS bus, in nested effects — see it and logs carry its id as
 * `actor`. Anonymous requests run with no principal attached.
 */
export const principal =
  <E, R>(resolve: PrincipalResolver<E, R>) =>
  <E2, R2>(
    app: HttpApp.Default<E2, R2>,
  ): HttpApp.Default<E | E2, R | R2 | HttpServerRequest.HttpServerRequest> =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const resolved = yield* resolve(request);
      return Option.isSome(resolved) ? yield* Principal.within(resolved.value)(app) : yield* app;
    });

/**
 * The {@link principal} middleware as an `HttpApi` layer — provide it next to
 * the api implementation (`serve`/`serveTest` take extra layers). The resolver
 * must not fail: treat unverifiable credentials as anonymous
 * (`Option.none()`), so guards answer 401, and let infrastructure failures
 * die. Its services (`R`) are captured when the layer is built.
 */
export const layer = <R = never>(
  resolve: PrincipalResolver<never, R>,
): Layer.Layer<never, never, Exclude<R, Scope.Scope>> =>
  HttpApiBuilder.middleware(
    Effect.map(
      Effect.context<R>(),
      (context) =>
        (app: HttpApp.Default): HttpApp.Default<never, HttpServerRequest.HttpServerRequest> =>
          principal((request) => Effect.provide(resolve(request), context))(app),
    ),
  );

/**
 * Route guard: the wrapped app (or handler) runs only when the request's
 * principal holds the permission. Fails with `Unauthenticated` (no/anonymous
 * principal) or `PermissionDenied`; `@structure-ai/http`'s problem mapping
 * renders them as 401/403.
 */
export const requirePermission =
  <Permission extends string>(
    policy: Policy<Permission, string>,
    permission: Permission,
    options?: CheckOptions,
  ) =>
  <A, E, R>(
    app: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | PermissionDenied | Unauthenticated, R> =>
    policy.require(permission, options)(app);

/** Route guard on a role rather than a permission. */
export const requireRole =
  <Role extends string>(
    policy: Policy<string, Role>,
    role: Role,
    options?: { readonly scope?: string },
  ) =>
  <A, E, R>(
    app: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | PermissionDenied | Unauthenticated, R> =>
    policy.requireRole(role, options)(app);

/** Route guard: any signed-in (non-anonymous) principal passes. */
export const requireAuthenticated = <A, E, R>(
  app: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | Unauthenticated, R> => Effect.zipRight(Principal.required, app);
