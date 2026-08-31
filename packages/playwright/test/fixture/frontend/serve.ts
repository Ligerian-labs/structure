// The "frontend the user brings": a static page plus a dev-style proxy that
// forwards /api/* to the app — the same shape a Vite/Next dev server gives.
const port = Number(process.env.TODO_WEB_PORT ?? 3200);
const appUrl =
  process.env.TODO_APP_URL ?? `http://127.0.0.1:${Number(process.env.TODO_APP_PORT ?? 3100)}`;

const safeFile = (pathname: string): string | undefined => {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  return /^[a-zA-Z0-9._-]+$/.test(relative) ? relative : undefined;
};

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const target = `${appUrl}${url.pathname.slice(4)}${url.search}`;
      const proxied = await fetch(target, {
        method: request.method,
        headers: {
          "content-type": "application/json",
          ...(request.headers.get("x-idempotency-key") !== null
            ? { "x-idempotency-key": request.headers.get("x-idempotency-key") ?? "" }
            : {}),
        },
        body:
          request.method === "GET" || request.method === "HEAD" ? undefined : await request.text(),
      });
      return new Response(proxied.body, {
        status: proxied.status,
        headers: { "content-type": proxied.headers.get("content-type") ?? "application/json" },
      });
    }
    const file = safeFile(url.pathname);
    if (file === undefined) return new Response("not found", { status: 404 });
    const path = `${import.meta.dir}/public/${file}`;
    return (await Bun.file(path).exists())
      ? new Response(Bun.file(path))
      : new Response("not found", { status: 404 });
  },
});

console.log(`frontend on http://127.0.0.1:${port} (api: ${appUrl})`);
