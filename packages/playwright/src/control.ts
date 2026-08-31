import * as HttpApi from "@effect/platform/HttpApi";
import * as HttpApiBuilder from "@effect/platform/HttpApiBuilder";
import * as HttpApiEndpoint from "@effect/platform/HttpApiEndpoint";
import * as HttpApiError from "@effect/platform/HttpApiError";
import * as HttpApiGroup from "@effect/platform/HttpApiGroup";
import type * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import type { AuthService } from "@structure-ai/auth";
import {
  type AnyMessageDefinition,
  CommandBus,
  type CommandBusService,
  QueryBus,
  type QueryBusService,
} from "@structure-ai/cqrs";
import { EventStore, type StoredEvent } from "@structure-ai/eventsourcing";
import { Chunk, Effect, Either, Layer, Redacted, Schema, Stream } from "effect";
import type { RecordedAuthEmail } from "./RecordingAuth.js";

// --- wire schemas --------------------------------------------------------------

const ControlExitSchema = Schema.Union(
  Schema.Struct({
    ok: Schema.Literal(true),
    value: Schema.Unknown,
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    failure: Schema.Struct({ tag: Schema.String, message: Schema.String }),
  }),
);

const DispatchBody = Schema.Struct({
  command: Schema.String,
  payload: Schema.Unknown,
  actor: Schema.optional(Schema.String),
});

const QueryBody = Schema.Struct({
  query: Schema.String,
  payload: Schema.Unknown,
  actor: Schema.optional(Schema.String),
});

const RegisterBody = Schema.Struct({
  email: Schema.String,
  password: Schema.String,
  displayName: Schema.optional(Schema.String),
});

const StoredEventWire = Schema.Struct({
  position: Schema.String,
  streamName: Schema.String,
  version: Schema.Number,
  type: Schema.String,
  schemaVersion: Schema.Number,
  payload: Schema.Unknown,
  metadata: Schema.Unknown,
});

// Every endpoint declares the platform's 401 error: the guard below fails
// with it when the bearer token is missing. Per-endpoint declaration (not
// HttpApiBuilder middleware) keeps the guard scoped to this server — the
// middleware service tag would leak onto every `serve()` in the same layer
// graph, i.e. onto the application's own server.
const unauthorized = (): Effect.Effect<never, HttpApiError.Unauthorized> =>
  Effect.fail(new HttpApiError.Unauthorized());

const guarded = (
  request: HttpServerRequest.HttpServerRequest,
  token: string,
): Effect.Effect<void, HttpApiError.Unauthorized> =>
  request.headers.authorization === `Bearer ${token}` ? Effect.void : unauthorized();

const controlGroup = HttpApiGroup.make("control")
  .add(
    HttpApiEndpoint.post("dispatch", "/commands")
      .setPayload(DispatchBody)
      .addSuccess(ControlExitSchema)
      .addError(HttpApiError.Unauthorized),
  )
  .add(
    HttpApiEndpoint.post("query", "/queries")
      .setPayload(QueryBody)
      .addSuccess(ControlExitSchema)
      .addError(HttpApiError.Unauthorized),
  )
  .add(
    HttpApiEndpoint.get("events", "/events")
      .addSuccess(Schema.Array(StoredEventWire))
      .addError(HttpApiError.Unauthorized),
  )
  .add(
    HttpApiEndpoint.post("drain", "/drain")
      .addSuccess(ControlExitSchema)
      .addError(HttpApiError.Unauthorized),
  )
  .add(
    HttpApiEndpoint.post("reset", "/reset")
      .addSuccess(ControlExitSchema)
      .addError(HttpApiError.Unauthorized),
  )
  .add(
    HttpApiEndpoint.post("register", "/auth/register")
      .setPayload(RegisterBody)
      .addSuccess(ControlExitSchema)
      .addError(HttpApiError.Unauthorized),
  );

const controlApi = HttpApi.make("test-control").add(controlGroup);

// --- exit helpers ---------------------------------------------------------------

/** Exit-capture wire shape: business outcomes are data, never HTTP errors. */
export type ControlExit = Schema.Schema.Type<typeof ControlExitSchema>;

const okExit = (value: unknown): ControlExit => ({ ok: true, value });
const failExit = (tag: string, message: string): ControlExit => ({
  ok: false as const,
  failure: { tag, message },
});

const tagOf = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const tag = (error as { readonly _tag: unknown })._tag;
    if (typeof tag === "string") return tag;
  }
  return "Unknown";
};

const describeError = (error: unknown): string => {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
};

const capture = (error: unknown): ControlExit => failExit(tagOf(error), describeError(error));

const notConfigured = (what: string): ControlExit =>
  failExit("NotConfigured", `no ${what} registered in TestControl.layer options`);

/** Both registry keys and message tags, for loud unknown-name errors. */
const namesOf = (
  registry: Readonly<Record<string, AnyMessageDefinition>> | undefined,
): ReadonlyArray<string> =>
  [
    ...new Set([
      ...Object.keys(registry ?? {}),
      ...Object.values(registry ?? {}).map((d) => d.tag),
    ]),
  ].sort();

const unknownName = (kind: string, name: string, registered: ReadonlyArray<string>): ControlExit =>
  registered.length === 0
    ? notConfigured(`${kind} registry`)
    : failExit(
        "HandlerNotFound",
        `unknown ${kind} "${name}"; registered: ${registered.join(", ")}`,
      );

// --- option types ----------------------------------------------------------------

/** Auth seeding option: the recording composition from {@link RecordingAuth}. */
export interface TestControlAuth {
  readonly tenantId: string;
  readonly service: AuthService;
  readonly emails: ReadonlyArray<RecordedAuthEmail>;
}

/** Options for {@link TestControl.layer}. */
export interface TestControlOptions<DrainR = never, ResetR = never> {
  /**
   * Port the control server binds. `0` binds a random free port (unit tests
   * read the bound address from the exposed `HttpServer`).
   */
  readonly port: number;
  /** Bearer token guarding every endpoint; minted and injected by `defineE2eConfig`. */
  readonly token: string;
  /** Command definitions dispatchable by tag from specs. */
  readonly commands?: Readonly<Record<string, AnyMessageDefinition>>;
  /** Query definitions runnable by tag from specs. */
  readonly queries?: Readonly<Record<string, AnyMessageDefinition>>;
  /**
   * Runs on every `control.drain()` / `eventually` poll: outbox relay,
   * projection catch-up — the same hook `@structure-ai/bdd` suites pass to
   * `defineFeatureSuite`.
   */
  readonly drain?: Effect.Effect<void, unknown, DrainR>;
  /** Test-scoped state reset for apps that can cheaply rebuild. */
  readonly reset?: Effect.Effect<void, unknown, ResetR>;
  /** Enables `POST /auth/register`: password registration with completed e-mail verification. */
  readonly auth?: TestControlAuth;
}

/** Environment variable names used by the config factory / client handoff. */
export const CONTROL_PORT_ENV = "STRUCTURE_TEST_CONTROL_PORT";
export const CONTROL_TOKEN_ENV = "STRUCTURE_TEST_CONTROL_TOKEN";
export const CONTROL_URL_ENV = "STRUCTURE_TEST_CONTROL_URL";

/** Default control port when `STRUCTURE_TEST_CONTROL_PORT` is unset. */
export const defaultControlPort = 4570;

/**
 * Reads the control settings the e2e environment injected (via
 * `defineE2eConfig` → backend `webServer.env`). Throws with the offending
 * variable's name — a misconfigured entrypoint must not start half-guarded.
 */
export const fromEnv = (): { readonly port: number; readonly token: string } => {
  const port = Number(process.env[CONTROL_PORT_ENV] ?? defaultControlPort);
  const token = process.env[CONTROL_TOKEN_ENV];
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${CONTROL_PORT_ENV}="${process.env[CONTROL_PORT_ENV]}" is not a valid port`);
  }
  if (token === undefined || token.length === 0) {
    throw new Error(
      `${CONTROL_TOKEN_ENV} must be set — defineE2eConfig injects it into the backend webServer environment`,
    );
  }
  return { port, token };
};

// --- handlers ------------------------------------------------------------------------

/** The heterogeneous-registry view of a bus dispatch: any definition, exit captured. */
type AnyDispatch = (
  definition: AnyMessageDefinition,
  payload: unknown,
  options?: { readonly actor?: string },
) => Effect.Effect<unknown, unknown>;

const dispatchOnBus = (
  bus: CommandBusService | QueryBusService,
  definition: AnyMessageDefinition,
  payload: unknown,
  actor: string | undefined,
): Effect.Effect<ControlExit> =>
  (bus.dispatch as AnyDispatch)(
    definition,
    payload,
    actor !== undefined ? { actor } : undefined,
  ).pipe(
    Effect.either,
    Effect.map((exit) =>
      Either.match(exit, {
        onLeft: capture,
        onRight: (value) =>
          okExit(Schema.encodeSync(definition.success as Schema.Schema<unknown, unknown>)(value)),
      }),
    ),
  );

const runHook = <R>(
  hook: Effect.Effect<void, unknown, R> | undefined,
  name: string,
): Effect.Effect<ControlExit, never, R> =>
  hook === undefined
    ? Effect.succeed(notConfigured(name))
    : Effect.map(Effect.either(hook), (exit) =>
        Either.match(exit, { onLeft: capture, onRight: () => okExit(undefined) }),
      );

const toWireEvent = (event: StoredEvent): Schema.Schema.Type<typeof StoredEventWire> => ({
  position: event.position.toString(),
  streamName: event.streamName,
  version: event.version,
  type: event.type,
  schemaVersion: event.schemaVersion,
  payload: event.payload,
  metadata: event.metadata,
});

/** Resolves a spec-provided name to a definition: registry key or message tag. */
const resolveDefinition = (
  registry: Readonly<Record<string, AnyMessageDefinition>> | undefined,
  name: string,
): AnyMessageDefinition | undefined =>
  registry?.[name] ?? Object.values(registry ?? {}).find((definition) => definition.tag === name);

const controlGroupLive = <DrainR, ResetR>(options: TestControlOptions<DrainR, ResetR>) =>
  HttpApiBuilder.group(controlApi, "control", (handlers) =>
    handlers
      .handle("dispatch", ({ payload: body, request }) =>
        Effect.gen(function* () {
          yield* guarded(request, options.token);
          const definition = resolveDefinition(options.commands, body.command);
          if (definition === undefined) {
            return unknownName("command", body.command, namesOf(options.commands));
          }
          if (definition._kind !== "command") {
            return failExit(
              "HandlerNotFound",
              `"${body.command}" is a ${definition._kind} definition; /commands expects commands`,
            );
          }
          const bus = yield* CommandBus;
          return yield* dispatchOnBus(bus, definition, body.payload, body.actor);
        }),
      )
      .handle("query", ({ payload: body, request }) =>
        Effect.gen(function* () {
          yield* guarded(request, options.token);
          const definition = resolveDefinition(options.queries, body.query);
          if (definition === undefined) {
            return unknownName("query", body.query, namesOf(options.queries));
          }
          if (definition._kind !== "query") {
            return failExit(
              "HandlerNotFound",
              `"${body.query}" is a ${definition._kind} definition; /queries expects queries`,
            );
          }
          const bus = yield* QueryBus;
          return yield* dispatchOnBus(bus, definition, body.payload, body.actor);
        }),
      )
      .handle("events", ({ request }) =>
        Effect.gen(function* () {
          yield* guarded(request, options.token);
          const store = yield* EventStore;
          const events = yield* Stream.runCollect(store.readAll());
          return Chunk.toReadonlyArray(events).map(toWireEvent);
        }),
      )
      .handle("drain", ({ request }) =>
        Effect.flatMap(guarded(request, options.token), () => runHook(options.drain, "drain hook")),
      )
      .handle("reset", ({ request }) =>
        Effect.flatMap(guarded(request, options.token), () => runHook(options.reset, "reset hook")),
      )
      .handle("register", ({ payload: body, request }) =>
        Effect.gen(function* () {
          yield* guarded(request, options.token);
          const auth = options.auth;
          if (auth === undefined) return notConfigured("auth option");
          // Seeding is fixture, not business outcome: infrastructure failures die loudly.
          const registered = yield* auth.service
            .registerPassword({
              tenantId: auth.tenantId,
              email: body.email,
              password: body.password,
              ...(body.displayName !== undefined && { displayName: body.displayName }),
            })
            .pipe(Effect.orDie);
          const verification = [...auth.emails]
            .reverse()
            .find((email) => email.kind === "email-verification" && email.to === body.email);
          if (verification === undefined) {
            return yield* Effect.die(`no verification e-mail captured for ${body.email}`);
          }
          yield* auth.service
            .verifyEmail(auth.tenantId, Redacted.make(verification.token))
            .pipe(Effect.orDie);
          return okExit({ userId: registered.id });
        }),
      ),
  );

// --- layer -------------------------------------------------------------------------

/**
 * The test control plane: a bearer-guarded second HTTP server exposing the
 * app's buses, event store, drain/reset hooks, and auth seeding to spec files.
 * Compose it only in a test entrypoint (`src/e2e-main.ts`):
 *
 * ```ts
 * const { port, token } = TestControl.fromEnv();
 * const control = TestControl.layer({ port, token, commands: { addTodo: AddTodo } });
 * // Layer.provide it with the app composition, merge it next to serve().
 * ```
 *
 * Exposes `HttpServer` so unit tests can read the bound address (pass
 * `port: 0`); specs reach it at `STRUCTURE_TEST_CONTROL_URL`, set by
 * `defineE2eConfig`.
 */
export const layer = <DrainR = never, ResetR = never>(
  options: TestControlOptions<DrainR, ResetR>,
) =>
  HttpApiBuilder.serve().pipe(
    Layer.provide(HttpApiBuilder.api(controlApi).pipe(Layer.provide(controlGroupLive(options)))),
    Layer.provideMerge(BunHttpServer.layer({ port: options.port })),
  );

/** Namespace view of the control plane for import ergonomics. */
export const TestControl = {
  /** See {@link layer}. */
  layer,
  /** See {@link fromEnv}. */
  fromEnv,
};
