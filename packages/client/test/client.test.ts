import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as FetchHttpClient from "@effect/platform/FetchHttpClient";
import type * as HttpClient from "@effect/platform/HttpClient";
import { Command, CommandHandler, layer as cqrsLayer, HandlerRegistry } from "@structure-ai/cqrs";
import {
  Api,
  ApiEndpoint,
  ApiGroup,
  GatewayTimeoutProblem,
  HttpApiBuilder,
  HttpCqrs,
  HttpServer,
  HttpServerRequest,
  serveTest,
  withDefaultErrors,
} from "@structure-ai/http";
import { Correlation, layerSilent } from "@structure-ai/observability";
import { Readiness } from "@structure-ai/runtime";
import { Cause, Context, Effect, Exit, Layer, Option, Ref, Schema, Scope } from "effect";
import * as StructureClient from "../src/index.js";

// --- server-side fixture -----------------------------------------------------

class Backordered extends Schema.TaggedError<Backordered>()("Backordered", {
  sku: Schema.String,
}) {}

const PlaceOrder = Command.define("PlaceOrder", {
  payload: Schema.Struct({ name: Schema.String, sku: Schema.String }),
  success: Schema.Struct({ accepted: Schema.Literal(true) }),
  failure: Backordered,
});

const orders = ApiGroup.make("orders")
  .add(HttpCqrs.commandEndpoint("placeOrder", "/orders", PlaceOrder))
  .add(
    ApiEndpoint.get("echo", "/echo").addSuccess(
      Schema.Struct({ correlationId: Schema.String, authorization: Schema.String }),
    ),
  )
  .add(withDefaultErrors(ApiEndpoint.get("flaky", "/flaky").addSuccess(Schema.String)))
  .add(ApiEndpoint.get("slow", "/slow").addSuccess(Schema.String));

const api = Api.make("client-test-api").add(orders);

// How many times each endpoint's handler actually ran — for retry assertions.
const placeOrderCalls = Effect.runSync(Ref.make(0));
const flakyCalls = Effect.runSync(Ref.make(0));

const registry = HandlerRegistry.layer(
  CommandHandler.make(PlaceOrder, (payload) =>
    Ref.updateAndGet(placeOrderCalls, (n) => n + 1).pipe(
      Effect.flatMap(() =>
        payload.sku === "sku-gone"
          ? Effect.fail(new Backordered({ sku: payload.sku }))
          : Effect.succeed({ accepted: true as const }),
      ),
    ),
  ),
);

// First call answers 504 (DispatchTimeout problem), later calls succeed.
const OrdersLive = HttpApiBuilder.group(api, "orders", (handlers) =>
  handlers
    .handle("placeOrder", HttpCqrs.command(PlaceOrder))
    .handle("echo", () =>
      Effect.map(HttpServerRequest.HttpServerRequest, (request) => ({
        correlationId: request.headers["x-correlation-id"] ?? "",
        authorization: request.headers.authorization ?? "",
      })),
    )
    .handle("flaky", () =>
      Ref.updateAndGet(flakyCalls, (n) => n + 1).pipe(
        Effect.flatMap((calls) =>
          calls === 1
            ? Effect.fail(
                new GatewayTimeoutProblem({ error: "DispatchTimeout", message: "timed out" }),
              )
            : Effect.succeed("recovered"),
        ),
      ),
    )
    .handle("slow", () => Effect.as(Effect.sleep("2 seconds"), "finally")),
);

const TestLive = serveTest.pipe(
  Layer.provide(HttpApiBuilder.api(api).pipe(Layer.provide(OrdersLive))),
  Layer.provide(cqrsLayer.pipe(Layer.provide(registry))),
  Layer.provideMerge(Readiness.layer),
  Layer.provide(layerSilent),
);

const scope = Effect.runSync(Scope.make());
let baseUrl = "";

beforeAll(async () => {
  const context = await Effect.runPromise(Layer.buildWithScope(TestLive, scope));
  const server = Context.get(context, HttpServer.HttpServer);
  const address = server.address;
  if (address._tag !== "TcpAddress") throw new Error("expected a tcp address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  await Effect.runPromise(Context.get(context, Readiness).setReady);
});

afterAll(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void));
});

// --- client fixture ----------------------------------------------------------

const run = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>): Promise<Exit.Exit<A, E>> =>
  Effect.runPromise(Effect.exit(Effect.provide(effect, FetchHttpClient.layer)));

const client = (options?: Partial<StructureClient.ClientOptions>) =>
  StructureClient.make(api, {
    baseUrl,
    timeout: "5 seconds",
    ...options,
  });

const readRef = <A>(ref: Ref.Ref<A>): A => Effect.runSync(Ref.get(ref));

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure");
  const failure = Cause.failureOption(exit.cause);
  if (Option.isNone(failure)) throw new Error("expected a typed failure");
  return failure.value;
};

// --- tests -------------------------------------------------------------------

describe("typed calls", () => {
  test("success decodes into the typed success body", async () => {
    const exit = await run(
      Effect.flatMap(client(), (c) =>
        c.orders.placeOrder({ payload: { name: "x", sku: "sku-1" } }),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value.accepted).toBe(true);
  });

  test("a declared business failure fails the call with the typed failure", async () => {
    const exit = await run(
      Effect.flatMap(client(), (c) =>
        c.orders.placeOrder({ payload: { name: "x", sku: "sku-gone" } }),
      ),
    );
    const failure = failureOf(exit);
    expect(failure).toBeInstanceOf(Backordered);
    expect((failure as Backordered).sku).toBe("sku-gone");
  });

  test("permanent business failures are not retried", async () => {
    const before = readRef(placeOrderCalls);
    await run(
      Effect.flatMap(client({ retry: { attempts: 5, baseDelay: 1 } }), (c) =>
        c.orders.placeOrder({ payload: { name: "x", sku: "sku-gone" } }),
      ),
    );
    expect(readRef(placeOrderCalls)).toBe(before + 1);
  });
});

describe("correlation", () => {
  test("an ambient correlation id is sent; a fresh one is generated otherwise", async () => {
    const ambient = await run(
      Correlation.within({ correlationId: "corr-fixed" })(
        Effect.flatMap(client(), (c) => c.orders.echo({})),
      ),
    );
    if (Exit.isSuccess(ambient)) expect(ambient.value.correlationId).toBe("corr-fixed");

    const fresh = await run(Effect.flatMap(client(), (c) => c.orders.echo({})));
    if (Exit.isSuccess(fresh)) expect(fresh.value.correlationId).not.toBe("");
  });
});

describe("bearer", () => {
  test("the token provider is applied as an authorization header", async () => {
    const exit = await run(
      Effect.flatMap(client({ bearer: () => "tok-123" }), (c) => c.orders.echo({})),
    );
    if (Exit.isSuccess(exit)) expect(exit.value.authorization).toBe("Bearer tok-123");
  });
});

describe("retry", () => {
  test("a dispatch timeout is retried and recovers", async () => {
    const exit = await run(
      Effect.flatMap(client({ retry: { attempts: 3, baseDelay: 1 } }), (c) => c.orders.flaky({})),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value).toBe("recovered");
    expect(readRef(flakyCalls)).toBe(2);
  });

  test("connection-refused is transient and exhausts attempts", async () => {
    const dead = StructureClient.make(api, {
      baseUrl: "http://127.0.0.1:1", // nothing listens here
      retry: { attempts: 2, baseDelay: 1 },
    });
    const exit = await run(Effect.flatMap(dead, (c) => c.orders.echo({})));
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe("timeout", () => {
  test("a slow endpoint fails with RequestTimeout", async () => {
    const exit = await run(
      Effect.flatMap(client({ timeout: "50 millis", retry: { attempts: 1 } }), (c) =>
        c.orders.slow({}),
      ),
    );
    const failure = failureOf(exit);
    expect(failure).toBeInstanceOf(StructureClient.RequestTimeout);
  });
});
