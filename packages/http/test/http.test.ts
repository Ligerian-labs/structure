import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  Command,
  CommandHandler,
  layer as cqrsLayer,
  HandlerRegistry,
  Query,
  QueryHandler,
} from "@structure-ai/cqrs";
import { Correlation, layerSilent } from "@structure-ai/observability";
import { Readiness } from "@structure-ai/runtime";
import { Context, Effect, Exit, Layer, Ref, Schema, Scope } from "effect";
import {
  Api,
  ApiEndpoint,
  ApiGroup,
  annotate,
  Docs,
  Health,
  HttpApiBuilder,
  HttpCqrs,
  HttpServer,
  problemStatus,
  serveTest,
  toProblem,
} from "../src/index.js";

// --- message definitions -----------------------------------------------------

const AddItem = Command.define("AddItem", {
  payload: Schema.Struct({ name: Schema.NonEmptyString }),
  success: Schema.Struct({ id: Schema.String, name: Schema.String }),
});

const ListItems = Query.define("ListItems", {
  payload: Schema.Struct({}),
  success: Schema.Struct({ items: Schema.Array(Schema.String) }),
});

// Business failure schemas: an app-specific tag and one colliding with the
// middleware taxonomy tag `InvariantViolation`.
class Backordered extends Schema.TaggedError<Backordered>()("Backordered", {
  sku: Schema.String,
}) {}

class OrdersClosed extends Schema.TaggedError<OrdersClosed>()("InvariantViolation", {
  rule: Schema.String,
}) {}

class OutOfStock extends Schema.TaggedError<OutOfStock>()("OutOfStock", {
  sku: Schema.String,
}) {}

const PlaceOrder = Command.define("PlaceOrder", {
  payload: Schema.Struct({ name: Schema.String, sku: Schema.String }),
  success: Schema.Struct({
    accepted: Schema.Literal(true),
    idempotencyKey: Schema.optional(Schema.String),
  }),
  failure: Schema.Union(Backordered, OrdersClosed),
});

const CheckStock = Query.define("CheckStock", {
  payload: Schema.Struct({ sku: Schema.String }),
  success: Schema.Struct({ available: Schema.Boolean }),
  failure: OutOfStock,
});

// --- api definition ----------------------------------------------------------

const items = ApiGroup.make("items")
  .add(HttpCqrs.commandEndpoint("addItem", "/items", AddItem))
  .add(HttpCqrs.queryEndpoint("listItems", "/items", ListItems))
  .add(HttpCqrs.commandEndpoint("placeOrder", "/orders", PlaceOrder))
  .add(HttpCqrs.queryEndpoint("checkStock", "/stock", CheckStock))
  .add(ApiEndpoint.get("boom", "/boom").addSuccess(Schema.String))
  .add(
    ApiEndpoint.get("whoami", "/whoami").addSuccess(
      Schema.Struct({ correlationId: Schema.String }),
    ),
  );

const api = Api.make("test-api")
  .add(items)
  .add(Health.group)
  .pipe(annotate({ title: "Test API", version: "1.2.3" }));

// --- implementation ----------------------------------------------------------

const state = Effect.runSync(Ref.make<ReadonlyArray<string>>([]));

const registry = HandlerRegistry.layer(
  CommandHandler.make(AddItem, (payload) =>
    Ref.updateAndGet(state, (all) => [...all, payload.name]).pipe(
      Effect.map((all) => ({ id: `item-${all.length}`, name: payload.name })),
    ),
  ),
  QueryHandler.make(ListItems, () => Effect.map(Ref.get(state), (all) => ({ items: all }))),
  CommandHandler.make(PlaceOrder, (payload, dispatch) =>
    payload.name === "backordered"
      ? Effect.fail(new Backordered({ sku: payload.sku }))
      : payload.name === "closed"
        ? Effect.fail(new OrdersClosed({ rule: "orders are closed" }))
        : Effect.succeed({
            accepted: true as const,
            ...(dispatch.idempotencyKey !== undefined && {
              idempotencyKey: dispatch.idempotencyKey,
            }),
          }),
  ),
  QueryHandler.make(CheckStock, (payload) =>
    payload.sku === "sku-gone"
      ? Effect.fail(new OutOfStock({ sku: payload.sku }))
      : Effect.succeed({ available: true }),
  ),
);

const ItemsLive = HttpApiBuilder.group(api, "items", (handlers) =>
  handlers
    .handle("addItem", HttpCqrs.command(AddItem))
    .handle("listItems", HttpCqrs.query(ListItems))
    .handle("placeOrder", HttpCqrs.command(PlaceOrder))
    .handle("checkStock", HttpCqrs.query(CheckStock))
    .handle("boom", () => Effect.die(new Error("secret internal detail")))
    .handle("whoami", () =>
      Effect.map(Correlation.current, (context) => ({
        correlationId: context.correlationId ?? "",
      })),
    ),
);

const TestLive = serveTest.pipe(
  Layer.provide(Docs.layer()),
  Layer.provide(HttpApiBuilder.api(api).pipe(Layer.provide([ItemsLive, Health.layer(api)]))),
  Layer.provide(cqrsLayer.pipe(Layer.provide(registry))),
  Layer.provideMerge(Readiness.layer),
  Layer.provide(layerSilent),
);

// --- test server lifecycle ---------------------------------------------------

const scope = Effect.runSync(Scope.make());
let context: Context.Context<Layer.Layer.Success<typeof TestLive>>;
let baseUrl = "";

beforeAll(async () => {
  context = await Effect.runPromise(Layer.buildWithScope(TestLive, scope));
  const server = Context.get(context, HttpServer.HttpServer);
  const address = server.address;
  if (address._tag !== "TcpAddress") throw new Error("expected a tcp address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  const readiness = Context.get(context, Readiness);
  await Effect.runPromise(readiness.register({ name: "db", run: Effect.succeed(true) }));
});

afterAll(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void));
});

const readiness = () => Context.get(context, Readiness);

// --- tests -------------------------------------------------------------------

describe("CQRS bridge", () => {
  test("POST with a valid payload returns the typed success body and correlation headers", async () => {
    const response = await fetch(`${baseUrl}/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "widget" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string; name: string };
    expect(body.name).toBe("widget");
    expect(body.id).toMatch(/^item-\d+$/);
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(response.headers.get("x-correlation-id")).toBeTruthy();
  });

  test("GET query endpoint returns the read model", async () => {
    await fetch(`${baseUrl}/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "gadget" }),
    });
    const response = await fetch(`${baseUrl}/items`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: ReadonlyArray<string> };
    expect(body.items).toContain("gadget");
  });

  test("POST failing payload refinement returns 400 with an issues list and no internals", async () => {
    const response = await fetch(`${baseUrl}/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });
    expect(response.status).toBe(400);
    const text = await response.text();
    const body = JSON.parse(text) as {
      error: string;
      message: string;
      issues: ReadonlyArray<string>;
    };
    expect(body.error).toBe("ValidationFailed");
    expect(body.issues.length).toBeGreaterThan(0);
    expect(text).not.toContain("    at "); // no stack frames
    expect(text).not.toContain("node_modules");
  });

  test("POST with a structurally invalid payload returns 400 with issues", async () => {
    const response = await fetch(`${baseUrl}/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: 5 }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { issues?: ReadonlyArray<unknown> };
    expect(Array.isArray(body.issues)).toBe(true);
    expect((body.issues ?? []).length).toBeGreaterThan(0);
  });
});

describe("routing and errors", () => {
  test("unknown route returns 404", async () => {
    const response = await fetch(`${baseUrl}/definitely-not-here`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("NotFound");
  });

  test("a handler defect returns a 500 problem with correlationId and no internals", async () => {
    const response = await fetch(`${baseUrl}/boom`);
    expect(response.status).toBe(500);
    const text = await response.text();
    const body = JSON.parse(text) as { error: string; correlationId?: string };
    expect(body.error).toBe("InternalServerError");
    expect(typeof body.correlationId).toBe("string");
    expect(text).not.toContain("secret internal detail");
    expect(text).not.toContain("    at ");
  });
});

describe("correlation", () => {
  test("a provided x-correlation-id reaches the handler and is echoed on the response", async () => {
    const response = await fetch(`${baseUrl}/whoami`, {
      headers: { "x-correlation-id": "corr-abc-123", "x-request-id": "req-42" },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { correlationId: string };
    expect(body.correlationId).toBe("corr-abc-123");
    expect(response.headers.get("x-correlation-id")).toBe("corr-abc-123");
    expect(response.headers.get("x-request-id")).toBe("req-42");
  });
});

describe("business failures", () => {
  test("a declared business failure returns 422 with the encoded failure body", async () => {
    const response = await fetch(`${baseUrl}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "backordered", sku: "sku-7" }),
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { _tag: string; sku: string };
    expect(body._tag).toBe("Backordered");
    expect(body.sku).toBe("sku-7");
  });

  test("a declared failure whose tag collides with a taxonomy tag keeps its contract", async () => {
    const response = await fetch(`${baseUrl}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "closed", sku: "sku-7" }),
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { _tag: string; rule: string };
    expect(body._tag).toBe("InvariantViolation");
    expect(body.rule).toBe("orders are closed");
  });

  test("a query business failure returns 422 with the encoded failure body", async () => {
    const response = await fetch(`${baseUrl}/stock?sku=sku-gone`);
    expect(response.status).toBe(422);
    const body = (await response.json()) as { _tag: string; sku: string };
    expect(body._tag).toBe("OutOfStock");
  });

  test("x-idempotency-key is forwarded to the dispatch envelope", async () => {
    const response = await fetch(`${baseUrl}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-idempotency-key": "idem-42" },
      body: JSON.stringify({ name: "ok", sku: "sku-1" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { accepted: boolean; idempotencyKey?: string };
    expect(body.accepted).toBe(true);
    expect(body.idempotencyKey).toBe("idem-42");
  });

  test("reusing an idempotency key with a different payload is a 409 problem", async () => {
    const post = (body: unknown) =>
      fetch(`${baseUrl}/orders`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-idempotency-key": "idem-409" },
        body: JSON.stringify(body),
      });
    const first = await post({ name: "ok", sku: "sku-1" });
    expect(first.status).toBe(200);
    const replay = await post({ name: "ok", sku: "sku-1" });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(await first.json());
    const mismatch = await post({ name: "ok", sku: "sku-2" });
    expect(mismatch.status).toBe(409);
    const problem = (await mismatch.json()) as { error: string; correlationId?: string };
    expect(problem.error).toBe("IdempotencyMismatch");
    expect(problem.correlationId).toBeDefined();
  });

  test("declared failure schemas are documented in openapi.json", async () => {
    const response = await fetch(`${baseUrl}/openapi.json`);
    const spec = await response.text();
    expect(spec).toContain("Backordered");
    expect(spec).toContain("OutOfStock");
  });
});

describe("health", () => {
  test("live always answers 200; ready reports 503 with checks before setReady, 200 after", async () => {
    const live = await fetch(`${baseUrl}/health/live`);
    expect(live.status).toBe(200);
    expect((await live.json()) as object).toEqual({ status: "live" });

    const notReady = await fetch(`${baseUrl}/health/ready`);
    expect(notReady.status).toBe(503);
    const notReadyBody = (await notReady.json()) as {
      ready: boolean;
      checks: ReadonlyArray<{ name: string; ok: boolean }>;
    };
    expect(notReadyBody.ready).toBe(false);
    expect(notReadyBody.checks).toEqual([{ name: "db", ok: true }]);

    await Effect.runPromise(readiness().setReady);
    const ready = await fetch(`${baseUrl}/health/ready`);
    expect(ready.status).toBe(200);
    const readyBody = (await ready.json()) as { ready: boolean };
    expect(readyBody.ready).toBe(true);
  });
});

describe("docs", () => {
  test("openapi.json is served and documents the endpoints and schemas", async () => {
    const response = await fetch(`${baseUrl}/openapi.json`);
    expect(response.status).toBe(200);
    const spec = (await response.json()) as {
      info: { title: string; version: string };
      paths: Record<string, Record<string, unknown>>;
      components: { schemas: Record<string, unknown> };
    };
    expect(spec.info.title).toBe("Test API");
    expect(spec.info.version).toBe("1.2.3");
    expect(spec.paths["/items"]).toBeDefined();
    expect(spec.paths["/items"]?.post).toBeDefined();
    expect(spec.paths["/items"]?.get).toBeDefined();
    expect(spec.paths["/health/live"]).toBeDefined();
    expect(spec.paths["/health/ready"]).toBeDefined();
    expect(Object.keys(spec.components.schemas).length).toBeGreaterThan(0);
    expect(JSON.stringify(spec)).toContain("BadRequestProblem");
  });

  test("swagger ui is served at /docs", async () => {
    const response = await fetch(`${baseUrl}/docs`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
  });
});

describe("problem mapping", () => {
  test("authorization errors map structurally: Unauthenticated → 401, PermissionDenied → 403, Unauthorized → 403", () => {
    const unauthenticated = toProblem(
      { _tag: "Unauthenticated", permission: "invoice:approve" },
      "corr-1",
    );
    expect(problemStatus(unauthenticated)).toBe(401);
    expect(unauthenticated.error).toBe("Unauthenticated");
    expect(unauthenticated.correlationId).toBe("corr-1");

    const denied = toProblem({
      _tag: "PermissionDenied",
      permission: "invoice:approve",
      principal: "bob",
      reason: "no role of [viewer] grants it",
    });
    expect(problemStatus(denied)).toBe(403);
    expect(denied.error).toBe("PermissionDenied");
    expect(denied.message).toBe('not allowed: "invoice:approve"');
    // The decision reason stays server-side.
    expect(JSON.stringify(denied)).not.toContain("viewer");

    const busDenied = toProblem({ _tag: "Unauthorized", tag: "ApproveInvoice" });
    expect(problemStatus(busDenied)).toBe(403);
  });

  test("idempotency refusals map to 409 without leaking the key", () => {
    const mismatch = toProblem({
      _tag: "IdempotencyMismatch",
      tag: "PlaceOrder",
      key: "secret-key",
    });
    expect(problemStatus(mismatch)).toBe(409);
    expect(mismatch.error).toBe("IdempotencyMismatch");
    expect(JSON.stringify(mismatch)).not.toContain("secret-key");

    const inFlight = toProblem({ _tag: "IdempotencyInFlight", tag: "PlaceOrder", key: "k" });
    expect(problemStatus(inFlight)).toBe(409);
    expect(inFlight.error).toBe("IdempotencyInFlight");
  });
});
