// @structure-ai/playwright/test — the spec-side half of the E2E kit.
//
// Plain JavaScript on purpose: spec files run under @playwright/test's Node
// runner, which cannot execute the repo's TypeScript-source exports. Keep
// this file dependency-free and in sync with src/test.d.ts.

const CONTROL_URL_ENV = "STRUCTURE_TEST_CONTROL_URL";
const CONTROL_TOKEN_ENV = "STRUCTURE_TEST_CONTROL_TOKEN";
const CONTROL_PORT_ENV = "STRUCTURE_TEST_CONTROL_PORT";

const DEFAULT_CONTROL_PORT = 4570;

export class ControlFailure extends Error {
  /**
   * @param {string} tag
   * @param {string} message
   * @param {number} status HTTP status when the failure came from transport (0 otherwise).
   */
  constructor(tag, message, status = 0) {
    super(message);
    this.name = "ControlFailure";
    this.tag = tag;
    this.status = status;
  }
}

const requireEnv = () => {
  const url = process.env[CONTROL_URL_ENV];
  const token = process.env[CONTROL_TOKEN_ENV];
  if (url === undefined || token === undefined) {
    throw new Error(
      `${CONTROL_URL_ENV} and ${CONTROL_TOKEN_ENV} must be set — import defineE2eConfig from "@structure-ai/playwright/test" and spread its result into defineConfig in playwright.config.ts`,
    );
  }
  return { url: url.replace(/\/$/, ""), token };
};

/**
 * @param {string} path
 * @param {unknown=} body
 * @param {string=} method
 * @returns {Promise<any>}
 */
async function call(path, body = {}, method = "POST") {
  const { url, token } = requireEnv();
  const response = await fetch(`${url}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  const text = await response.text();
  if (response.status === 401) {
    throw new ControlFailure("Unauthorized", "control plane rejected the token", 401);
  }
  let exit = null;
  try {
    exit = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    exit = null;
  }
  if (exit === null) {
    throw new ControlFailure(
      "ControlServer",
      `${method} ${path} -> ${response.status}: ${text.slice(0, 500)}`,
      response.status,
    );
  }
  return exit;
}

const unwrap = (exit) => {
  if (exit.ok) return exit.value;
  throw new ControlFailure(exit.failure.tag, exit.failure.message);
};

/**
 * Builds a control-plane client. The exported `control` singleton covers the
 * common case; call this with explicit settings when a spec needs a second app.
 *
 * @param {{ url?: string, token?: string }} [options]
 */
export function makeControl(options = {}) {
  const saved =
    options.url !== undefined && options.token !== undefined
      ? { url: options.url.replace(/\/$/, ""), token: options.token }
      : null;
  if (saved !== null) {
    process.env[CONTROL_URL_ENV] = saved.url;
    process.env[CONTROL_TOKEN_ENV] = saved.token;
  }
  return {
    /**
     * Dispatches a registered command; resolves with the encoded success value,
     * rejects with ControlFailure (tag + message) on business failure.
     * @param {string} command
     * @param {Record<string, unknown>} [payload]
     * @param {{ actor?: string }} [options]
     */
    async dispatch(command, payload = {}, options = {}) {
      const body = { command, payload };
      if (options.actor !== undefined) body.actor = options.actor;
      return unwrap(await call("/commands", body));
    },
    /**
     * Runs a registered query; resolves with the encoded success value.
     * @param {string} query
     * @param {Record<string, unknown>} [payload]
     */
    async query(query, payload = {}) {
      return unwrap(await call("/queries", { query, payload }));
    },
    /**
     * Every stored event in global order (positions as strings).
     * @returns {Promise<ReadonlyArray<Record<string, unknown>>>}
     */
    async events() {
      return call("/events", undefined, "GET");
    },
    /**
     * Runs the registered drain hook (outbox relay, projection catch-up).
     * Resolves silently when no hook is registered — `eventually` relies on this.
     */
    async drain() {
      const exit = await call("/drain", {});
      if (exit.ok || exit.failure.tag === "NotConfigured") return;
      throw new ControlFailure(exit.failure.tag, exit.failure.message);
    },
    /**
     * Runs the registered reset hook; rejects when none is registered.
     */
    async reset() {
      return unwrap(await call("/reset", {}));
    },
    auth: {
      /**
       * Seeds a password user with completed e-mail verification through the
       * real AuthService; resolves with `{ userId }`.
       * @param {{ email: string, password: string, displayName?: string }} input
       */
      async register(input) {
        return unwrap(await call("/auth/register", input));
      },
    },
  };
}

/** The control-plane client for the app `defineE2eConfig` launched. */
export const control = makeControl();

/**
 * Retries `fn` until it holds, draining the app between attempts — eventual
 * consistency stays the framework's problem, not the spec's. `fn` may return
 * `false` to keep polling; any thrown error is retried until the timeout.
 *
 * @template T
 * @param {() => T | false | Promise<T | false>} fn
 * @param {{ timeoutMs?: number, intervalMs?: number, drain?: boolean }} [options]
 * @returns {Promise<T>}
 */
export async function eventually(fn, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5000;
  const intervalMs = options.intervalMs ?? 100;
  const shouldDrain = options.drain ?? true;
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    if (shouldDrain) await control.drain();
    try {
      const value = await fn();
      if (value !== false) return value;
      lastError = new Error("eventually: predicate returned false");
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`eventually: condition did not hold within ${timeoutMs}ms — ${message}`, {
    cause: lastError,
  });
}

const randomHexToken = () => {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

const webServerFor = (server, env) => ({
  command: server.command,
  url: server.url,
  timeout: server.timeoutMs ?? 60_000,
  reuseExistingServer: server.reuseExisting ?? false,
  ...(env !== undefined ? { env } : {}),
});

/**
 * The Playwright config factory: launches backend and frontend as webServers,
 * mints the control token, hands port + token to both processes, and exports
 * URL + token to spec workers through the environment.
 *
 * ```ts
 * // playwright.config.ts
 * import { defineConfig } from "@playwright/test";
 * import { defineE2eConfig } from "@structure-ai/playwright/test";
 *
 * export default defineConfig({
 *   testDir: "test/e2e",
 *   ...defineE2eConfig({
 *     backend: {
 *       command: "bun run src/e2e-main.ts",
 *       url: "http://127.0.0.1:3000/health/ready",
 *     },
 *     frontend: {
 *       command: "bun run frontend dev",
 *       url: "http://127.0.0.1:5173",
 *     },
 *   }),
 * });
 * ```
 *
 * @param {{
 *   backend: { command: string, url: string, timeoutMs?: number, reuseExisting?: boolean },
 *   frontend: { command: string, url: string, timeoutMs?: number, reuseExisting?: boolean },
 *   controlPort?: number,
 *   controlToken?: string,
 *   testTimeoutMs?: number,
 * }} options
 */
export function defineE2eConfig(options) {
  const { backend, frontend } = options;
  if (backend === undefined || backend.command === undefined || backend.url === undefined) {
    throw new Error("defineE2eConfig: backend requires { command, url }");
  }
  if (frontend === undefined || frontend.command === undefined || frontend.url === undefined) {
    throw new Error("defineE2eConfig: frontend requires { command, url }");
  }
  const controlPort = options.controlPort ?? DEFAULT_CONTROL_PORT;
  // Config re-evaluates in every Playwright worker process: reuse a token
  // already present in the environment (set by the runner's first load and
  // inherited by forked workers) instead of minting a fresh one per worker.
  const controlToken = options.controlToken ?? process.env[CONTROL_TOKEN_ENV] ?? randomHexToken();
  process.env[CONTROL_URL_ENV] = `http://127.0.0.1:${controlPort}`;
  process.env[CONTROL_TOKEN_ENV] = controlToken;
  return {
    timeout: options.testTimeoutMs ?? 30_000,
    use: { baseURL: frontend.url },
    webServer: [
      webServerFor(backend, {
        ...process.env,
        [CONTROL_PORT_ENV]: String(controlPort),
        [CONTROL_TOKEN_ENV]: controlToken,
      }),
      webServerFor(frontend),
    ],
  };
}
