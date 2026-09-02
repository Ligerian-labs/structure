import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { layerSilent } from "@structure-ai/observability";
import { Readiness } from "@structure-ai/runtime";
import { Cause, Context, Effect, Exit, HashMap, Layer, Logger, Schema, Scope } from "effect";
import {
  Api,
  ApiEndpoint,
  ApiGroup,
  Docs,
  HttpApiBuilder,
  HttpServer,
  InvalidMounts,
  type Mount,
  type ServeTestOptions,
  serveTestWith,
} from "../src/index.js";

// --- a small HttpApi to share the server with ---------------------------------

const items = ApiGroup.make("items")
  .add(
    ApiEndpoint.get("listItems", "/items").addSuccess(
      Schema.Struct({ items: Schema.Array(Schema.String) }),
    ),
  )
  .add(ApiEndpoint.get("slow", "/slow").addSuccess(Schema.Struct({ done: Schema.Boolean })));

const api = Api.make("mounts-api").add(items);

const ItemsLive = HttpApiBuilder.group(api, "items", (handlers) =>
  handlers
    .handle("listItems", () => Effect.succeed({ items: ["widget"] }))
    .handle("slow", () => Effect.sleep("150 millis").pipe(Effect.as({ done: true }))),
);

const ApiLive = HttpApiBuilder.api(api).pipe(Layer.provide(ItemsLive));

// --- static fixture ------------------------------------------------------------

const APP_JS = "console.log('hello from the spa bundle');\n";
const INDEX_HTML = "<!doctype html><title>spa</title><div id=app></div>\n";

interface Fixture {
  readonly root: string;
  readonly outside: string;
  readonly cleanup: () => Promise<void>;
}

const makeFixture = async (): Promise<Fixture> => {
  const base = await mkdtemp(join(tmpdir(), "structure-http-static-"));
  const root = join(base, "dist");
  const outside = join(base, "secret.txt");
  await mkdir(join(root, "assets"), { recursive: true });
  await mkdir(join(root, "sub"), { recursive: true });
  await mkdir(join(root, "empty-dir"), { recursive: true });
  await writeFile(join(root, "index.html"), INDEX_HTML);
  await writeFile(join(root, "sub", "index.html"), "<p>sub index</p>");
  await writeFile(join(root, "assets", "app.js"), APP_JS);
  await writeFile(join(root, "assets", "app.js.gz"), gzipSync(Buffer.from(APP_JS)));
  await writeFile(join(root, "assets", "app.js.br"), brotliCompressSync(Buffer.from(APP_JS)));
  await writeFile(join(root, "assets", "plain.css"), "body{}");
  await writeFile(join(root, ".env"), "SECRET=1");
  await writeFile(outside, "top secret");
  await symlink(outside, join(root, "escape.txt"));
  return { root, outside, cleanup: () => rm(base, { recursive: true, force: true }) };
};

// --- server helper --------------------------------------------------------------

interface Running {
  readonly baseUrl: string;
  readonly readiness: Context.Tag.Service<typeof Readiness>;
  readonly close: () => Promise<void>;
}

const start = async (options: ServeTestOptions): Promise<Running> => {
  const scope = Effect.runSync(Scope.make());
  const layer = serveTestWith(options).pipe(
    Layer.provide(Docs.layer()),
    Layer.provide(ApiLive),
    Layer.provideMerge(Readiness.layer),
    Layer.provide(layerSilent),
  );
  const context = await Effect.runPromise(Layer.buildWithScope(layer, scope));
  const address = Context.get(context, HttpServer.HttpServer).address;
  if (address._tag !== "TcpAddress") throw new Error("expected a tcp address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    readiness: Context.get(context, Readiness),
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
};

/** A raw handler in the shape `makeAuthHandler` / an MCP web handler return. */
const authLike = {
  handler: async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/auth/login") {
      const body = (await request.json()) as { email?: string };
      return Response.json({ path: url.pathname, email: body.email }, { status: 201 });
    }
    return Response.json(
      { path: url.pathname, method: request.method, query: url.search },
      { headers: { "cache-control": "no-store" } },
    );
  },
};

// --- mounts ----------------------------------------------------------------------

describe("mounts", () => {
  let server: Running;

  beforeAll(async () => {
    server = await start({
      mounts: [
        { prefix: "/auth", handler: authLike.handler },
        { prefix: "/api", handler: async () => Response.json({ mount: "api" }) },
        { prefix: "/api/v2", handler: async () => Response.json({ mount: "api-v2" }) },
        { prefix: "/items", handler: async () => Response.json({ mount: "items" }) },
        {
          prefix: "/broken",
          handler: async () => {
            throw new Error("secret mount detail");
          },
        },
      ],
    });
  });
  afterAll(() => server.close());

  test("a raw web handler receives the untouched request and its response is returned as-is", async () => {
    const response = await fetch(`${server.baseUrl}/auth/session?x=1`, {
      headers: { "x-correlation-id": "corr-mount-1" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ path: "/auth/session", method: "GET", query: "?x=1" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    // Correlation headers are stamped on mount responses like on api routes.
    expect(response.headers.get("x-correlation-id")).toBe("corr-mount-1");
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });

  test("request bodies reach the mounted handler", async () => {
    const response = await fetch(`${server.baseUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@b.c" }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ path: "/auth/login", email: "a@b.c" });
  });

  test("the longest matching prefix wins, on segment boundaries only", async () => {
    expect(await (await fetch(`${server.baseUrl}/api/v2/things`)).json()).toEqual({
      mount: "api-v2",
    });
    expect(await (await fetch(`${server.baseUrl}/api/v2`)).json()).toEqual({ mount: "api-v2" });
    expect(await (await fetch(`${server.baseUrl}/api/v20`)).json()).toEqual({ mount: "api" });
    expect(await (await fetch(`${server.baseUrl}/api`)).json()).toEqual({ mount: "api" });
    const noMatch = await fetch(`${server.baseUrl}/apix`);
    expect(noMatch.status).toBe(404);
    expect(((await noMatch.json()) as { error: string }).error).toBe("NotFound");
  });

  test("mounts are evaluated before the HttpApi router", async () => {
    const response = await fetch(`${server.baseUrl}/items`);
    expect(await response.json()).toEqual({ mount: "items" });
  });

  test("an unmatched path falls through to the HttpApi 404 problem", async () => {
    const response = await fetch(`${server.baseUrl}/nowhere`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("NotFound");
    expect(body.message).toBe("route not found");
  });

  test("a throwing mount handler becomes a 500 problem with the correlation id and no internals", async () => {
    const response = await fetch(`${server.baseUrl}/broken/x`, {
      headers: { "x-correlation-id": "corr-broken" },
    });
    expect(response.status).toBe(500);
    const text = await response.text();
    const body = JSON.parse(text) as { error: string; correlationId?: string };
    expect(body.error).toBe("InternalServerError");
    expect(body.correlationId).toBe("corr-broken");
    expect(text).not.toContain("secret mount detail");
  });

  test("invalid prefixes fail the layer with InvalidMounts", async () => {
    const build = (mounts: ReadonlyArray<Mount>) =>
      Effect.runPromiseExit(
        Effect.scoped(
          Layer.build(
            serveTestWith({ mounts }).pipe(
              Layer.provide(ApiLive),
              Layer.provideMerge(Readiness.layer),
              Layer.provide(layerSilent),
            ),
          ),
        ),
      );
    const handler = async () => new Response("ok");
    for (const bad of [
      [{ prefix: "auth", handler }],
      [{ prefix: "/auth/", handler }],
      [{ prefix: "/auth?x", handler }],
      [
        { prefix: "/auth", handler },
        { prefix: "/auth", handler },
      ],
    ]) {
      const exit = await build(bad);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const defect = Cause.dieOption(exit.cause);
        expect(defect._tag).toBe("Some");
        if (defect._tag === "Some") {
          expect(defect.value).toBeInstanceOf(InvalidMounts);
          expect((defect.value as InvalidMounts).classification).toBe("permanent");
        }
      }
    }
  });
});

// --- static assets ---------------------------------------------------------------

describe("static assets", () => {
  let fixture: Fixture;
  let server: Running;

  beforeAll(async () => {
    fixture = await makeFixture();
    server = await start({
      mounts: [{ prefix: "/auth", handler: authLike.handler }],
      static: {
        directory: fixture.root,
        spaFallback: "index.html",
        cacheControl: (path) =>
          path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
      },
    });
  });
  afterAll(async () => {
    await server.close();
    await fixture.cleanup();
  });

  test("serves files with content type, nosniff, etag, and the configured cache-control", async () => {
    const response = await fetch(`${server.baseUrl}/assets/app.js`, {
      headers: { "accept-encoding": "identity" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/javascript");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("etag")).toBeTruthy();
    expect(response.headers.get("vary")).toBe("accept-encoding");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(await response.text()).toBe(APP_JS);
  });

  test("the directory root serves index.html; a nested directory serves its own index", async () => {
    const root = await fetch(`${server.baseUrl}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toContain("text/html");
    expect(root.headers.get("cache-control")).toBe("no-cache");
    expect(await root.text()).toBe(INDEX_HTML);

    const sub = await fetch(`${server.baseUrl}/sub/`);
    expect(sub.status).toBe(200);
    expect(await sub.text()).toBe("<p>sub index</p>");
  });

  test("serves precompressed .br / .gz siblings when the client accepts them", async () => {
    const br = await fetch(`${server.baseUrl}/assets/app.js`, {
      headers: { "accept-encoding": "br" },
      decompress: false,
    } as RequestInit);
    expect(br.status).toBe(200);
    expect(br.headers.get("content-encoding")).toBe("br");
    expect(br.headers.get("content-type")).toContain("text/javascript");
    expect(br.headers.get("vary")).toBe("accept-encoding");
    const brBytes = new Uint8Array(await br.arrayBuffer());
    expect(Buffer.from(brBytes).equals(brotliCompressSync(Buffer.from(APP_JS)))).toBe(true);

    const gz = await fetch(`${server.baseUrl}/assets/app.js`, {
      headers: { "accept-encoding": "gzip, deflate" },
      decompress: false,
    } as RequestInit);
    expect(gz.status).toBe(200);
    expect(gz.headers.get("content-encoding")).toBe("gzip");
    expect(Buffer.from(await gz.arrayBuffer()).equals(gzipSync(Buffer.from(APP_JS)))).toBe(true);

    // No sibling: identity, even when the client would accept compression.
    const css = await fetch(`${server.baseUrl}/assets/plain.css`, {
      headers: { "accept-encoding": "br, gzip" },
    });
    expect(css.status).toBe(200);
    expect(css.headers.get("content-encoding")).toBeNull();
    expect(await css.text()).toBe("body{}");
  });

  test("answers 304 to a matching if-none-match", async () => {
    const first = await fetch(`${server.baseUrl}/assets/app.js`, {
      headers: { "accept-encoding": "identity" },
    });
    const etag = first.headers.get("etag") ?? "";
    expect(etag).not.toBe("");
    const second = await fetch(`${server.baseUrl}/assets/app.js`, {
      headers: { "accept-encoding": "identity", "if-none-match": etag },
    });
    expect(second.status).toBe(304);
    expect(second.headers.get("etag")).toBe(etag);
    expect(second.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await second.text()).toBe("");
  });

  test("HEAD returns headers only", async () => {
    const response = await fetch(`${server.baseUrl}/assets/app.js`, {
      method: "HEAD",
      headers: { "accept-encoding": "identity" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/javascript");
    expect(response.headers.get("content-length")).toBe(String(Buffer.byteLength(APP_JS)));
    expect(await response.text()).toBe("");
  });

  test("the SPA fallback is served only for navigations that accept html", async () => {
    const navigation = await fetch(`${server.baseUrl}/app/settings/42`, {
      headers: { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8" },
    });
    expect(navigation.status).toBe(200);
    expect(navigation.headers.get("content-type")).toContain("text/html");
    expect(navigation.headers.get("cache-control")).toBe("no-cache");
    expect(await navigation.text()).toBe(INDEX_HTML);

    const xhr = await fetch(`${server.baseUrl}/app/settings/42`, {
      headers: { accept: "application/json" },
    });
    expect(xhr.status).toBe(404);
    expect(((await xhr.json()) as { error: string }).error).toBe("NotFound");

    const noAccept = await fetch(`${server.baseUrl}/app/missing.js`, {
      headers: { accept: "*/*" },
    });
    expect(noAccept.status).toBe(404);
  });

  test("HttpApi routes and mounts take precedence over static files and the fallback", async () => {
    const apiRoute = await fetch(`${server.baseUrl}/items`, { headers: { accept: "text/html" } });
    expect(apiRoute.status).toBe(200);
    expect(await apiRoute.json()).toEqual({ items: ["widget"] });

    const docs = await fetch(`${server.baseUrl}/docs`, { headers: { accept: "text/html" } });
    expect(docs.status).toBe(200);
    expect(await docs.text()).not.toBe(INDEX_HTML);

    const mount = await fetch(`${server.baseUrl}/auth/me`, { headers: { accept: "text/html" } });
    expect(await mount.json()).toEqual({ path: "/auth/me", method: "GET", query: "" });
  });

  test("refuses traversal, symlink escapes, dotfiles, and null bytes", async () => {
    const attempts = [
      "/%2e%2e/secret.txt",
      "/assets/%2e%2e/%2e%2e/secret.txt",
      "/assets/..%2f..%2fsecret.txt",
      "/..%5csecret.txt",
      "/escape.txt",
      "/.env",
      "/assets/app.js%00.html",
      "/%ZZ",
    ];
    for (const path of attempts) {
      const response = await fetch(`${server.baseUrl}${path}`, { headers: { accept: "*/*" } });
      expect(response.status, path).toBe(404);
      const text = await response.text();
      expect(text, path).not.toContain("top secret");
      expect(text, path).not.toContain("SECRET=1");
    }
  });

  test("never lists a directory", async () => {
    const response = await fetch(`${server.baseUrl}/empty-dir/`, { headers: { accept: "*/*" } });
    expect(response.status).toBe(404);
    const assets = await fetch(`${server.baseUrl}/assets`, { headers: { accept: "*/*" } });
    expect(assets.status).toBe(404);
    expect(await assets.text()).not.toContain("app.js");
  });

  test("only GET and HEAD are served statically", async () => {
    const response = await fetch(`${server.baseUrl}/assets/app.js`, { method: "POST" });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toBe("NotFound");
  });
});

describe("static assets under a prefix", () => {
  let fixture: Fixture;
  let server: Running;

  beforeAll(async () => {
    fixture = await makeFixture();
    server = await start({
      static: { directory: fixture.root, prefix: "/ui", spaFallback: "index.html" },
    });
  });
  afterAll(async () => {
    await server.close();
    await fixture.cleanup();
  });

  test("files resolve relative to the prefix; the default cache-control is no-cache", async () => {
    const asset = await fetch(`${server.baseUrl}/ui/assets/app.js`, {
      headers: { "accept-encoding": "identity" },
    });
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toBe("no-cache");
    expect(await asset.text()).toBe(APP_JS);

    const index = await fetch(`${server.baseUrl}/ui`);
    expect(index.status).toBe(200);
    expect(await index.text()).toBe(INDEX_HTML);

    const fallback = await fetch(`${server.baseUrl}/ui/route/x`, {
      headers: { accept: "text/html" },
    });
    expect(fallback.status).toBe(200);
    expect(await fallback.text()).toBe(INDEX_HTML);
  });

  test("paths outside the prefix are not static", async () => {
    const outside = await fetch(`${server.baseUrl}/assets/app.js`, {
      headers: { accept: "text/html" },
    });
    expect(outside.status).toBe(404);
    const sibling = await fetch(`${server.baseUrl}/uix`, { headers: { accept: "text/html" } });
    expect(sibling.status).toBe(404);
  });
});

// --- shutdown ----------------------------------------------------------------------

describe("graceful shutdown", () => {
  test("in-flight mount and api requests finish during the grace period, readiness flips first", async () => {
    const server = await start({
      gracePeriod: "1 second",
      mounts: [
        {
          prefix: "/slow-mount",
          handler: async () => {
            await new Promise((resolve) => setTimeout(resolve, 150));
            return Response.json({ drained: true });
          },
        },
      ],
    });
    await Effect.runPromise(server.readiness.setReady);

    const mountRequest = fetch(`${server.baseUrl}/slow-mount`);
    const apiRequest = fetch(`${server.baseUrl}/slow`);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const closing = server.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await Effect.runPromise(server.readiness.isReady)).toBe(false);

    const mountResponse = await mountRequest;
    expect(mountResponse.status).toBe(200);
    expect(await mountResponse.json()).toEqual({ drained: true });

    const apiResponse = await apiRequest;
    expect(apiResponse.status).toBe(200);
    expect(await apiResponse.json()).toEqual({ done: true });

    await closing;
  });
});

describe("boundary telemetry through serve", () => {
  test("api routes log their endpoint template and mounts their prefix, never the requested path", async () => {
    const lines: Array<Record<string, unknown>> = [];
    const capture = Logger.replace(
      Logger.defaultLogger,
      Logger.make(({ message, annotations }) => {
        if (String(message) === "http request") {
          lines.push(Object.fromEntries(HashMap.toEntries(annotations)));
        }
      }),
    );
    const scope = Effect.runSync(Scope.make());
    const layer = serveTestWith({ mounts: [{ prefix: "/auth", handler: authLike.handler }] }).pipe(
      Layer.provide(ApiLive),
      Layer.provideMerge(Readiness.layer),
      Layer.provide(capture),
    );
    const context = await Effect.runPromise(Layer.buildWithScope(layer, scope));
    const address = Context.get(context, HttpServer.HttpServer).address;
    if (address._tag !== "TcpAddress") throw new Error("expected a tcp address");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      await fetch(`${baseUrl}/items`);
      await fetch(`${baseUrl}/auth/callback/secret-token-value`);
      await fetch(`${baseUrl}/probe-secret`);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    expect(lines.map((line) => line.route)).toEqual(["/items", "/auth/*", "(unmatched)"]);
    const text = JSON.stringify(lines);
    expect(text).not.toContain("secret-token-value");
    expect(text).not.toContain("probe-secret");
  });
});
