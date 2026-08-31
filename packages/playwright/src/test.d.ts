/**
 * Spec-side types for `@structure-ai/playwright/test`. The implementation is
 * hand-written plain JavaScript (`src/test.js`) because spec files run under
 * `@playwright/test`'s Node runner; this declaration file is the contract.
 */

/** A stored event as served by `control.events()` (positions as strings). */
export interface StoredEventWire {
  readonly position: string;
  readonly streamName: string;
  readonly version: number;
  readonly type: string;
  readonly schemaVersion: number;
  readonly payload: unknown;
  readonly metadata: unknown;
}

/** A control-plane failure surfaced to specs: tag + message, never an HTTP detail. */
export declare class ControlFailure extends Error {
  readonly tag: string;
  readonly status: number;
}

/** Dispatch options. */
export interface DispatchOptions {
  readonly actor?: string;
}

/** The control-plane client for the app `defineE2eConfig` launched. */
export interface Control {
  /**
   * Dispatches a registered command; resolves with the encoded success value,
   * rejects with {@link ControlFailure} on business failure. Pass the success
   * type parameter to read the result: `dispatch<{ todoId: string }>(...)`.
   */
  dispatch<T = unknown>(
    command: string,
    payload?: Record<string, unknown>,
    options?: DispatchOptions,
  ): Promise<T>;
  /** Runs a registered query; resolves with the encoded success value. */
  query<T = unknown>(query: string, payload?: Record<string, unknown>): Promise<T>;
  /** Every stored event in global order. */
  events(): Promise<ReadonlyArray<StoredEventWire>>;
  /** Runs the registered drain hook; resolves silently when none is registered. */
  drain(): Promise<void>;
  /** Runs the registered reset hook; rejects when none is registered. */
  reset(): Promise<void>;
  readonly auth: {
    /** Seeds a password user with completed e-mail verification; resolves with `{ userId }`. */
    register(input: { email: string; password: string; displayName?: string }): Promise<{
      userId: string;
    }>;
  };
}

export declare function makeControl(options?: { url?: string; token?: string }): Control;

export declare const control: Control;

/**
 * Retries `fn` until it holds, draining the app between attempts. `fn` may
 * return `false` to keep polling; thrown errors are retried until the timeout.
 */
export declare function eventually<T>(
  fn: () => T | false | Promise<T | false>,
  options?: { timeoutMs?: number; intervalMs?: number; drain?: boolean },
): Promise<T>;

/** One subprocess the config launches and waits on. */
export interface E2eServer {
  readonly command: string;
  readonly url: string;
  readonly timeoutMs?: number;
  readonly reuseExisting?: boolean;
}

/** Options for {@link defineE2eConfig}. */
export interface E2eConfigOptions {
  /** The app entrypoint; `url` should be its `/health/ready` (or live) probe. */
  readonly backend: E2eServer;
  /** The frontend dev server (or static server) specs browse. */
  readonly frontend: E2eServer;
  /** Control-plane port shared by both processes. Default: 4570. */
  readonly controlPort?: number;
  /** Explicit control token; minted randomly when omitted. */
  readonly controlToken?: string;
  /** Per-test timeout. Default: 30_000. */
  readonly testTimeoutMs?: number;
}

/**
 * Builds the Playwright config fragment: webServers for backend and frontend,
 * control token minted and handed to both sides via the environment, `baseURL`
 * pointed at the frontend. Spread into `defineConfig`.
 */
export declare function defineE2eConfig(options: E2eConfigOptions): {
  timeout: number;
  use: { baseURL: string };
  webServer: Array<{
    command: string;
    url: string;
    timeout: number;
    reuseExisting: boolean;
    env?: Record<string, string>;
  }>;
};
