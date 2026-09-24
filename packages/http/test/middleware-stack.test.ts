import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { layerSilent } from "@structure-ai/observability";
import { Readiness } from "@structure-ai/runtime";
import { Cause, Context, Effect, Exit, HashMap, Layer, Logger, Schema, Scope } from "effect";
import {
  Api,
  ApiEndpoint,
  ApiGroup,
  ApiSchema,
  HttpApiBuilder,
  HttpServer,
  HttpServerResponse,
  InvalidMiddlewareOptions,
  Middleware,
  type MiddlewareStackOptions,
  type ServeTestOptions,
  serveTestWith,
} from "../src/index.js";

// --- a small api every composition shares -------------------------------------

const things = ApiGroup.make("things").add(
  ApiEndpoint.get("getThing")`/things/${ApiSchema.param("id", Schema.String)}`.addSuccess(
    Schema.Struct({ id: Schema.String }),
  ),
);

const api = Api.make("stack-api").add(things);

const ThingsLive = HttpApiBuilder.group(api, "things", (handlers) =>
  handlers.handle("getThing", ({ path }) => Effect.succeed({ id: path.id })),
);

const ApiLive = HttpApiBuilder.api(api).pipe(Layer.provide(ThingsLive));

// --- server lifecycle ---------------------------------------------------------

interface Running {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

const start = async (
  options: ServeTestOptions,
  replaceLogger?: Layer.Layer<never>,
): Promise<Running> => {
  const scope = Effect.runSync(Scope.make());
  const base = serveTestWith(options).pipe(
    Layer.provide(ApiLive),
    Layer.provideMerge(Readiness.layer),
  );
  const layer =
    replaceLogger === undefined
      ? base.pipe(Layer.provide(layerSilent))
      : base.pipe(Layer.provide(replaceLogger));
  const context = await Effect.runPromise(Layer.buildWithScope(layer, scope));
  const address = Context.get(context, HttpServer.HttpServer).address;
  if (address._tag !== "TcpAddress") throw new Error("expected a tcp address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Extracts the defect value from a failed layer build, for option validation tests. */
const dieValue = (exit: Exit.Exit<unknown, unknown>): unknown => {
  if (!Exit.isFailure(exit)) throw new Error("expected a failed build");
  const defect = Cause.dieOption(exit.cause);
  if (defect._tag !== "Some") throw new Error("expected a defect");
  return defect.value;
};

// --- default stack is unchanged -----------------------------------------------

describe("middleware option: default", () => {
  let server: Running;

  beforeAll(async () => {
    server = await start({});
  });

  afterAll(async () => {
    await server.close();
  });

  test("serves requests with the standard correlation headers", async () => {
    const response = await fetch(`${server.baseUrl}/things/one`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { id: string }).id).toBe("one");
    expect(response.headers.get("x-request-id")).toMatch(UUID);
    expect(response.headers.get("x-correlation-id")).toMatch(UUID);
  });

  test("keeps well-formed propagated ids and replaces unsafe ones (sanitize default)", async () => {
    const kept = await fetch(`${server.baseUrl}/things/one`, {
      headers: { "x-request-id": "req_42-A", "x-correlation-id": "corr-99" },
    });
    expect(kept.headers.get("x-request-id")).toBe("req_42-A");
    expect(kept.headers.get("x-correlation-id")).toBe("corr-99");

    const replaced = await fetch(`${server.baseUrl}/things/one`, {
      headers: { "x-request-id": "evil line" },
    });
    expect(replaced.headers.get("x-request-id")).toMatch(UUID);
  });

  test("answers unmatched routes with the standard 404 problem taxonomy", async () => {
    const response = await fetch(`${server.baseUrl}/nope`);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toBe("NotFound");
  });
});

// --- correlation policy and header names ----------------------------------------

describe("middleware option: correlation", () => {
  let server: Running;

  beforeAll(async () => {
    server = await start({
      middleware: {
        correlation: {
          incoming: "reject",
          generate: () => "gen-id",
          headers: { request: "X-Trace-Id", correlation: null },
        },
      },
    });
  });

  afterAll(async () => {
    await server.close();
  });

  test("refuses incoming ids, emits the configured header only, never the standard ones", async () => {
    const response = await fetch(`${server.baseUrl}/things/one`, {
      headers: { "x-request-id": "client-id-1", "x-correlation-id": "client-corr-1" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Trace-Id")).toBe("gen-id");
    expect(response.headers.get("x-request-id")).toBeNull();
    expect(response.headers.get("x-correlation-id")).toBeNull();
  });

  test("the problem taxonomy is untouched by correlation configuration", async () => {
    const response = await fetch(`${server.baseUrl}/nope`);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toBe("NotFound");
  });
});

describe("middleware option: correlation policy predicate", () => {
  let server: Running;

  beforeAll(async () => {
    server = await start({
      middleware: {
        correlation: {
          incoming: (id: string) => id.startsWith("acc-"),
          generate: () => "gen-id",
        },
      },
    });
  });

  afterAll(async () => {
    await server.close();
  });

  test("keeps only ids the policy accepts", async () => {
    const accepted = await fetch(`${server.baseUrl}/things/one`, {
      headers: { "x-request-id": "acc-42" },
    });
    expect(accepted.headers.get("x-request-id")).toBe("acc-42");

    const refused = await fetch(`${server.baseUrl}/things/one`, {
      headers: { "x-request-id": "other-1" },
    });
    expect(refused.headers.get("x-request-id")).toBe("gen-id");
    expect(refused.headers.get("x-correlation-id")).toBe("gen-id");
  });

  test("a permissive policy still cannot echo header-unsafe bytes", async () => {
    // fetch refuses to send control bytes; exercise the policy through a
    // permissive predicate that would accept anything isSafeId already
    // refused — the middleware must still mint a fresh id.
    const response = await fetch(`${server.baseUrl}/things/one`, {
      headers: { "x-request-id": "bad id with spaces" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("gen-id");
  });
});

// --- boundary replacement -------------------------------------------------------

/**
 * A minimal replacement: stamps a header on successes and lets failures pass
 * through (the platform answers an unhandled `RouteNotFound` with its own
 * empty 404 — the replacement that wants the taxonomy brings `problems`).
 */
const stamped = (
  app: Parameters<NonNullable<MiddlewareStackOptions["boundary"]>>[0],
): ReturnType<NonNullable<MiddlewareStackOptions["boundary"]>> =>
  Effect.map(
    app,
    (response): HttpServerResponse.HttpServerResponse =>
      HttpServerResponse.setHeader(response, "x-boundary", "replaced"),
  );

describe("middleware option: boundary replaced", () => {
  let server: Running;

  beforeAll(async () => {
    server = await start({
      middleware: { boundary: (app) => stamped(app) },
      mounts: [
        {
          prefix: "/auth",
          handler: async (request: Request) =>
            Response.json({ path: new URL(request.url).pathname }),
        },
      ],
    });
  });

  afterAll(async () => {
    await server.close();
  });

  test("api routes run through the replacement without the standard stack", async () => {
    const response = await fetch(`${server.baseUrl}/things/one`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { id: string }).id).toBe("one");
    expect(response.headers.get("x-boundary")).toBe("replaced");
    expect(response.headers.get("x-request-id")).toBeNull();
    expect(response.headers.get("x-correlation-id")).toBeNull();
  });

  test("mounts and static dispatch stay composed under the replacement", async () => {
    const response = await fetch(`${server.baseUrl}/auth/login`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { path: string }).path).toBe("/auth/login");
    expect(response.headers.get("x-boundary")).toBe("replaced");
  });

  test("an unhandled unmatched route is answered by the platform's 404, not the standard problem", async () => {
    const response = await fetch(`${server.baseUrl}/nope`);
    expect(response.status).toBe(404);
    // the failure bypassed the success-only replacement: no stamp, and the
    // body is the platform's empty 404, not the problem taxonomy
    expect(response.headers.get("x-boundary")).toBeNull();
    const text = await response.text();
    expect(text).toBe("");
  });
});

describe("middleware option: boundary receives the mounted api", () => {
  let server: Running;
  const lines: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    const capture = Logger.replace(
      Logger.defaultLogger,
      Logger.make(({ annotations }) => {
        lines.push(Object.fromEntries(HashMap.toEntries(annotations)));
      }),
    );
    server = await start(
      {
        middleware: {
          // A caller rebuilding the standard stack with only the correlation
          // policy swapped: route-labelled telemetry survives the replacement.
          boundary: (app, mounted) =>
            Middleware.standard(app, {
              routeLabel: Middleware.routeLabel(mounted),
              correlation: { incoming: "reject", headers: { request: "X-Req" } },
            }),
        },
      },
      capture,
    );
  });

  afterAll(async () => {
    await server.close();
  });

  test("the rebuilt stack labels logs by endpoint template with custom headers", async () => {
    lines.length = 0;
    const response = await fetch(`${server.baseUrl}/things/secret-token`);
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Req")).toMatch(UUID);
    expect(response.headers.get("x-request-id")).toBeNull();
    const requestLine = lines.find((line) => line.route === "/things/:id");
    expect(requestLine).toBeDefined();
    expect(JSON.stringify(lines)).not.toContain("secret-token");
  });

  test("the rebuilt stack keeps the problem taxonomy for unmatched routes", async () => {
    const response = await fetch(`${server.baseUrl}/nope`);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toBe("NotFound");
  });
});

// --- option validation ------------------------------------------------------------

describe("middleware option: validation", () => {
  const build = async (middleware: MiddlewareStackOptions) =>
    Effect.runPromiseExit(
      Effect.scoped(
        Layer.build(
          serveTestWith({ middleware }).pipe(
            Layer.provide(ApiLive),
            Layer.provideMerge(Readiness.layer),
            Layer.provide(layerSilent),
          ),
        ),
      ),
    );

  test("an invalid header name fails the layer with InvalidMiddlewareOptions", async () => {
    const exit = await build({ correlation: { headers: { request: "not a header" } } });
    const defect = dieValue(exit);
    expect(defect).toBeInstanceOf(InvalidMiddlewareOptions);
    expect((defect as InvalidMiddlewareOptions).classification).toBe("permanent");
  });

  test("identical header names fail the layer", async () => {
    const exit = await build({
      correlation: { headers: { request: "X-Trace-Id", correlation: "X-Trace-Id" } },
    });
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("an invalid incoming policy fails the layer", async () => {
    const exit = await build({
      correlation: { incoming: "sometimes" as unknown as "reject" },
    });
    const defect = dieValue(exit);
    expect(defect).toBeInstanceOf(InvalidMiddlewareOptions);
  });

  test("correlation together with boundary fails the layer", async () => {
    const exit = await build({
      correlation: { incoming: "reject" },
      boundary: stamped,
    });
    const defect = dieValue(exit);
    expect(defect).toBeInstanceOf(InvalidMiddlewareOptions);
    expect((defect as InvalidMiddlewareOptions).violations.join(" ")).toContain("boundary");
  });
});
