import { describe, expect, test } from "bun:test";
import * as HttpApi from "@effect/platform/HttpApi";
import * as HttpApiBuilder from "@effect/platform/HttpApiBuilder";
import * as HttpApiEndpoint from "@effect/platform/HttpApiEndpoint";
import * as HttpApiError from "@effect/platform/HttpApiError";
import * as HttpApiGroup from "@effect/platform/HttpApiGroup";
import * as HttpServer from "@effect/platform/HttpServer";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import { Effect, Layer, Option, Schema } from "effect";
import {
  HttpAuthorization,
  PermissionDenied,
  Policy,
  Principal,
  Unauthenticated,
} from "../src/index.js";

const policy = Policy.define({
  resources: { invoice: ["read", "approve"] },
  roles: {
    viewer: { grants: ["invoice:read"] },
    manager: { inherits: ["viewer"], grants: ["invoice:approve"] },
  },
});

const tokens: Record<string, Principal> = {
  "token-ada": { id: "ada", roles: ["manager"] },
  "token-bob": { id: "bob", roles: ["viewer"] },
};

const resolver = HttpAuthorization.fromBearer((token) =>
  Effect.succeed(Option.fromNullable(tokens[token])),
);

const requestWith = (headers: Record<string, string> = {}) =>
  HttpServerRequest.fromWeb(new Request("http://localhost/invoices", { headers }));

describe("HttpAuthorization (HttpApp level)", () => {
  test("bearerToken parses the Authorization header strictly", () => {
    expect(HttpAuthorization.bearerToken(requestWith({ authorization: "Bearer abc" }))).toEqual(
      Option.some("abc"),
    );
    expect(HttpAuthorization.bearerToken(requestWith({ authorization: "bearer abc" }))).toEqual(
      Option.some("abc"),
    );
    expect(HttpAuthorization.bearerToken(requestWith({ authorization: "Basic abc" }))).toEqual(
      Option.none(),
    );
    expect(HttpAuthorization.bearerToken(requestWith())).toEqual(Option.none());
  });

  test("principal middleware attaches the resolved principal for the rest of the request", async () => {
    const app = Effect.map(Principal.current, (current) =>
      HttpServerResponse.text(Option.isSome(current) ? current.value.id : "anonymous"),
    );
    const wrapped = HttpAuthorization.principal(resolver)(app);
    const bodyFor = async (headers?: Record<string, string>) => {
      const response = await Effect.runPromise(
        wrapped.pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, requestWith(headers)),
        ),
      );
      return await HttpServerResponse.toWeb(response).text();
    };
    expect(await bodyFor({ authorization: "Bearer token-ada" })).toBe("ada");
    expect(await bodyFor({ authorization: "Bearer unknown" })).toBe("anonymous");
    expect(await bodyFor()).toBe("anonymous");
  });

  test("guards fail typed: Unauthenticated without a principal, PermissionDenied with the wrong one", async () => {
    const handler = Effect.succeed("approved");
    const guarded = HttpAuthorization.requirePermission(policy, "invoice:approve")(handler);
    const runAs = <A, E>(principal: Principal | undefined, effect: Effect.Effect<A, E>) =>
      Effect.runPromise(principal === undefined ? effect : Principal.within(principal)(effect));

    expect(await runAs(tokens["token-ada"], guarded)).toBe("approved");
    expect(await runAs(tokens["token-bob"], Effect.flip(guarded))).toBeInstanceOf(PermissionDenied);
    expect(await runAs(undefined, Effect.flip(guarded))).toBeInstanceOf(Unauthenticated);

    const roleGuarded = HttpAuthorization.requireRole(policy, "manager")(handler);
    expect(await runAs(tokens["token-bob"], Effect.flip(roleGuarded))).toBeInstanceOf(
      PermissionDenied,
    );
    const authenticated = HttpAuthorization.requireAuthenticated(handler);
    expect(await runAs(tokens["token-bob"], authenticated)).toBe("approved");
    expect(await runAs(Principal.anonymous, Effect.flip(authenticated))).toBeInstanceOf(
      Unauthenticated,
    );
  });
});

// --- end to end through an HttpApi, no server -------------------------------

const invoices = HttpApiGroup.make("invoices")
  .add(
    HttpApiEndpoint.post("approve", "/invoices/approve")
      .addSuccess(Schema.Struct({ approvedBy: Schema.String }))
      .addError(HttpApiError.Unauthorized)
      .addError(HttpApiError.Forbidden),
  )
  .add(HttpApiEndpoint.get("whoami", "/whoami").addSuccess(Schema.String));

const api = HttpApi.make("test").add(invoices);

const InvoicesLive = HttpApiBuilder.group(api, "invoices", (handlers) =>
  handlers
    .handle("approve", () =>
      Effect.map(Principal.required, (principal) => ({ approvedBy: principal.id })).pipe(
        HttpAuthorization.requirePermission(policy, "invoice:approve"),
        // Map the guard failures onto the endpoint's declared errors.
        Effect.catchTags({
          Unauthenticated: () => Effect.fail(new HttpApiError.Unauthorized()),
          PermissionDenied: () => Effect.fail(new HttpApiError.Forbidden()),
        }),
      ),
    )
    .handle("whoami", () =>
      Effect.map(Principal.current, (current) =>
        Option.isSome(current) ? current.value.id : "anonymous",
      ),
    ),
);

const ApiLive = HttpApiBuilder.api(api).pipe(
  Layer.provide(InvoicesLive),
  Layer.provide(HttpAuthorization.layer(resolver)),
  Layer.provideMerge(HttpServer.layerContext),
);

describe("HttpAuthorization.layer (HttpApi level)", () => {
  test("the layer resolves the principal per request; guards answer 401/403/200", async () => {
    const { handler, dispose } = HttpApiBuilder.toWebHandler(ApiLive);
    const call = (path: string, method: string, token?: string) =>
      handler(
        new Request(`http://localhost${path}`, {
          method,
          headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
        }),
      );
    try {
      const anonymous = await call("/invoices/approve", "POST");
      expect(anonymous.status).toBe(401);
      const viewer = await call("/invoices/approve", "POST", "token-bob");
      expect(viewer.status).toBe(403);
      const manager = await call("/invoices/approve", "POST", "token-ada");
      expect(manager.status).toBe(200);
      expect(await manager.json()).toEqual({ approvedBy: "ada" });
      const whoami = await call("/whoami", "GET", "token-bob");
      expect(await whoami.json()).toBe("bob");
      const nobody = await call("/whoami", "GET");
      expect(await nobody.json()).toBe("anonymous");
    } finally {
      await dispose();
    }
  });
});
