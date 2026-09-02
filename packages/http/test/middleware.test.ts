import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Context, Effect, Exit, HashMap, Layer, Logger, Metric, Schema, Scope } from "effect";
import {
  Api,
  ApiEndpoint,
  ApiGroup,
  ApiSchema,
  Docs,
  HttpApiBuilder,
  HttpServer,
  Middleware,
  serveTest,
} from "../src/index.js";

// --- api definition ----------------------------------------------------------

const things = ApiGroup.make("things")
  .add(
    ApiEndpoint.get("getThing")`/things/${ApiSchema.param("id", Schema.String)}`.addSuccess(
      Schema.Struct({ id: Schema.String }),
    ),
  )
  .add(
    ApiEndpoint.get(
      "getPart",
    )`/things/${ApiSchema.param("id", Schema.String)}/parts/${ApiSchema.param("part", Schema.String)}`.addSuccess(
      Schema.Struct({ id: Schema.String, part: Schema.String }),
    ),
  )
  .add(ApiEndpoint.post("createThing", "/things").addSuccess(Schema.Struct({ id: Schema.String })));

const api = Api.make("middleware-api").add(things);

const ThingsLive = HttpApiBuilder.group(api, "things", (handlers) =>
  handlers
    .handle("getThing", ({ path }) => Effect.succeed({ id: path.id }))
    .handle("getPart", ({ path }) => Effect.succeed({ id: path.id, part: path.part }))
    .handle("createThing", () => Effect.succeed({ id: "thing-1" })),
);

// --- log capture -------------------------------------------------------------

interface Line {
  readonly message: string;
  readonly annotations: Record<string, unknown>;
}

const lines: Array<Line> = [];

const capture = Logger.replace(
  Logger.defaultLogger,
  Logger.make(({ message, annotations }) => {
    lines.push({
      message: Array.isArray(message) ? message.map(String).join(" ") : String(message),
      annotations: Object.fromEntries(HashMap.toEntries(annotations)),
    });
  }),
);

const TestLive = serveTest.pipe(
  Layer.provide(Docs.layer()),
  Layer.provide(HttpApiBuilder.api(api).pipe(Layer.provide(ThingsLive))),
  Layer.provide(capture),
);

// --- test server lifecycle ---------------------------------------------------

const scope = Effect.runSync(Scope.make());
let baseUrl = "";

beforeAll(async () => {
  const context = await Effect.runPromise(Layer.buildWithScope(TestLive, scope));
  const address = Context.get(context, HttpServer.HttpServer).address;
  if (address._tag !== "TcpAddress") throw new Error("expected a tcp address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void));
});

const requestLines = () => lines.filter((line) => line.message === "http request");
const lastRequestLine = (): Line => {
  const line = requestLines().at(-1);
  if (line === undefined) throw new Error("no http request log line captured");
  return line;
};
const allLogText = () => JSON.stringify(lines);

const metricLabels = () =>
  Effect.runPromise(
    Effect.map(Metric.snapshot, (pairs) =>
      pairs.map((pair) => ({
        name: pair.metricKey.name,
        tags: Object.fromEntries(pair.metricKey.tags.map((tag) => [tag.key, tag.value])),
      })),
    ),
  );

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// --- tests -------------------------------------------------------------------

describe("routeLabel", () => {
  const resolve = Middleware.routeLabel(api);

  test("resolves the matched endpoint template for method + path", () => {
    expect(resolve("GET", "/things/abc")).toBe("/things/:id");
    expect(resolve("GET", "/things/abc/parts/p-1")).toBe("/things/:id/parts/:part");
    expect(resolve("POST", "/things")).toBe("/things");
  });

  test("falls back to (unmatched) for unknown paths, wrong methods and partial matches", () => {
    expect(resolve("GET", "/nope")).toBe(Middleware.UNMATCHED_ROUTE);
    expect(resolve("DELETE", "/things/abc")).toBe(Middleware.UNMATCHED_ROUTE);
    expect(resolve("GET", "/things/abc/extra")).toBe(Middleware.UNMATCHED_ROUTE);
    expect(resolve("GET", "/things")).toBe(Middleware.UNMATCHED_ROUTE);
  });

  test("literal segments are matched literally, never as regex", () => {
    const dotted = Middleware.routeLabel(
      Api.make("dots").add(
        ApiGroup.make("g").add(ApiEndpoint.get("spec", "/openapi.json").addSuccess(Schema.String)),
      ),
    );
    expect(dotted("GET", "/openapi.json")).toBe("/openapi.json");
    expect(dotted("GET", "/openapiXjson")).toBe(Middleware.UNMATCHED_ROUTE);
  });

  test("extra templates label routes mounted outside the api", () => {
    const withDocs = Middleware.routeLabel(api, { extra: ["/docs", "/openapi.json"] });
    expect(withDocs("GET", "/docs")).toBe("/docs");
    expect(withDocs("GET", "/openapi.json")).toBe("/openapi.json");
  });
});

describe("boundary logger", () => {
  test("a request to /things/secret-token logs the route template and never the token", async () => {
    lines.length = 0;
    const response = await fetch(`${baseUrl}/things/secret-token`);
    expect(response.status).toBe(200);

    const line = lastRequestLine();
    expect(line.annotations.route).toBe("/things/:id");
    expect(line.annotations.method).toBe("GET");
    expect(line.annotations.status).toBe(200);
    expect(typeof line.annotations.durationMs).toBe("number");
    expect(line.annotations.path).toBeUndefined();
    expect(line.annotations.requestId).toBe(response.headers.get("x-request-id"));
    expect(line.annotations.correlationId).toBe(response.headers.get("x-correlation-id"));
    expect(allLogText()).not.toContain("secret-token");

    const labels = await metricLabels();
    expect(JSON.stringify(labels)).not.toContain("secret-token");
    expect(
      labels.some(
        (metric) =>
          metric.name === "http_server_duration_ms" &&
          metric.tags.route === "/things/:id" &&
          metric.tags.method === "GET",
      ),
    ).toBe(true);
    expect(
      labels.some(
        (metric) =>
          metric.name === "http_request_duration_seconds" &&
          metric.tags.route === "/things/:id" &&
          metric.tags.method === "GET" &&
          metric.tags.status === "200",
      ),
    ).toBe(true);
  });

  test("an unmatched request logs (unmatched) and not the probed url", async () => {
    lines.length = 0;
    const response = await fetch(`${baseUrl}/wp-admin/probe-me`);
    expect(response.status).toBe(404);

    const line = lastRequestLine();
    expect(line.annotations.route).toBe("(unmatched)");
    expect(line.annotations.status).toBe(404);
    expect(allLogText()).not.toContain("wp-admin");
    expect(allLogText()).not.toContain("probe-me");

    const labels = await metricLabels();
    expect(JSON.stringify(labels)).not.toContain("wp-admin");
    expect(
      labels.some(
        (metric) =>
          metric.name === "http_request_duration_seconds" &&
          metric.tags.route === "(unmatched)" &&
          metric.tags.status === "404",
      ),
    ).toBe(true);
  });

  test("the query string never reaches the log line", async () => {
    lines.length = 0;
    await fetch(`${baseUrl}/things/x?token=leaky-secret`);
    expect(lastRequestLine().annotations.route).toBe("/things/:id");
    expect(allLogText()).not.toContain("leaky-secret");
  });
});

describe("correlation sanitizing", () => {
  test("an injected x-request-id is replaced by a fresh uuid everywhere", async () => {
    lines.length = 0;
    const response = await fetch(`${baseUrl}/things/one`, {
      headers: { "x-request-id": "evil line", "x-correlation-id": "also\tbad" },
    });
    expect(response.status).toBe(200);
    const requestId = response.headers.get("x-request-id") ?? "";
    const correlationId = response.headers.get("x-correlation-id") ?? "";
    expect(requestId).toMatch(UUID);
    expect(correlationId).toMatch(UUID);
    expect(lastRequestLine().annotations.requestId).toBe(requestId);
    expect(lastRequestLine().annotations.correlationId).toBe(correlationId);
    expect(allLogText()).not.toContain("evil");
    expect(allLogText()).not.toContain("bad");
  });

  test("ids longer than 64 characters are replaced", async () => {
    const response = await fetch(`${baseUrl}/things/one`, {
      headers: { "x-request-id": "a".repeat(65) },
    });
    expect(response.headers.get("x-request-id")).toMatch(UUID);
  });

  test("well-formed propagated ids are kept verbatim", async () => {
    const response = await fetch(`${baseUrl}/things/one`, {
      headers: { "x-request-id": "req_42-A", "x-correlation-id": "b".repeat(64) },
    });
    expect(response.headers.get("x-request-id")).toBe("req_42-A");
    expect(response.headers.get("x-correlation-id")).toBe("b".repeat(64));
  });

  test("isSafeId accepts only [A-Za-z0-9_-]{1,64}", () => {
    expect(Middleware.isSafeId("abc-DEF_123")).toBe(true);
    expect(Middleware.isSafeId("")).toBe(false);
    expect(Middleware.isSafeId("has space")).toBe(false);
    expect(Middleware.isSafeId("new\nline")).toBe(false);
    expect(Middleware.isSafeId("x".repeat(64))).toBe(true);
    expect(Middleware.isSafeId("x".repeat(65))).toBe(false);
  });
});
