import { ValidationFailed } from "@structure-ai/domain";
import { Correlation, Metrics } from "@structure-ai/observability";
import { Context, Data, Duration, Effect, Layer, Option, Schema } from "effect";
import { ArrayFormatter, type ParseError } from "effect/ParseResult";
import {
  DispatchTimeout,
  HandlerNotFound,
  IdempotencyInFlight,
  IdempotencyMismatch,
  type Unauthorized,
} from "./errors.js";
import { HandlerRegistry, type Registration } from "./handler.js";
import type {
  CommandDefinition,
  Dispatch,
  MessageDefinition,
  MessageKind,
  QueryDefinition,
} from "./message.js";

/** Per-dispatch options supplied by the caller. */
export interface DispatchOptions {
  /**
   * Commands only: a caller-chosen key making the dispatch idempotent. The
   * key is scoped to the acting principal and the command tag, and bound to
   * the payload it was first used with: a replay by the same actor with the
   * same payload returns the cached success without running the handler
   * again; a different payload fails `IdempotencyMismatch`; a dispatch that
   * is still running fails `IdempotencyInFlight`.
   */
  readonly idempotencyKey?: string;
  /**
   * Principal performing the action, given to the authorization hook and
   * propagated on correlation. Falls back to the actor already present in
   * the ambient correlation context.
   */
  readonly actor?: string;
  /** Deadline for the handler; exceeding it fails with `DispatchTimeout`. */
  readonly timeout?: Duration.DurationInput;
}

/** Failures the bus itself can produce, before or around the handler. */
export type DispatchError =
  | ValidationFailed
  | HandlerNotFound
  | Unauthorized
  | DispatchTimeout
  | IdempotencyMismatch
  | IdempotencyInFlight;

/** What the authorization hook sees: the action, not the endpoint. */
export interface AuthorizationRequest {
  readonly tag: string;
  readonly kind: MessageKind;
  readonly actor?: string;
  /** The already-decoded payload of the message. */
  readonly payload: unknown;
}

/**
 * Authorization hook invoked on every dispatch, after boundary validation
 * and before the handler (and before any idempotency-cache lookup). It
 * decides per action — a message tag plus actor plus payload — never per
 * transport endpoint.
 */
export class Authorizer extends Context.Tag("@structure-ai/cqrs/Authorizer")<
  Authorizer,
  {
    readonly authorize: (request: AuthorizationRequest) => Effect.Effect<void, Unauthorized>;
  }
>() {
  /** Default policy: every dispatch is allowed. */
  static readonly allowAll: Layer.Layer<Authorizer> = Layer.succeed(Authorizer, {
    authorize: () => Effect.void,
  });
}

/**
 * Identity of one idempotent dispatch as the store sees it. Records are
 * keyed by `(tag, actor, key)`: the same key from two principals never
 * collides, and an anonymous dispatch (`actor` undefined) is its own scope.
 * `payloadHash` is the sha-256 (hex) of the validated payload in its wire
 * form with object keys sorted, so equal payloads hash equally regardless
 * of key order.
 */
export interface IdempotencyContext {
  readonly key: string;
  readonly tag: string;
  readonly actor?: string;
  readonly payloadHash: string;
}

/**
 * What `begin` found for the context:
 *
 * - `Completed` — the same actor already ran this key with this payload;
 *   `result` is the wire-encoded success recorded by `complete`.
 * - `Claimed` — nothing was recorded (or an expired record was replaced);
 *   the caller now owns the key and must `complete` or `release` it.
 * - `InFlight` — a claim exists but no result yet: another dispatch is
 *   still running.
 * - `Mismatch` — a record exists for this key with a different payload
 *   hash, whatever its state.
 */
export type BeginOutcome = Data.TaggedEnum<{
  Completed: { readonly result: unknown };
  Claimed: Record<never, never>;
  InFlight: Record<never, never>;
  Mismatch: Record<never, never>;
}>;
export const BeginOutcome = Data.taggedEnum<BeginOutcome>();

/** Port for command idempotency; see {@link IdempotencyStore}. */
export interface IdempotencyStoreService {
  /**
   * Atomically claims the context or reports why it cannot. Two concurrent
   * `begin` calls for the same context must yield exactly one `Claimed`.
   */
  readonly begin: (context: IdempotencyContext) => Effect.Effect<BeginOutcome>;
  /**
   * Records the wire-encoded success of a claimed context. Later `begin`
   * calls for the same context return `Completed` with this value.
   */
  readonly complete: (context: IdempotencyContext, result: unknown) => Effect.Effect<void>;
  /**
   * Frees a claim whose dispatch failed or was interrupted, so a retry can
   * run the handler. Must not discard a completed record.
   */
  readonly release: (context: IdempotencyContext) => Effect.Effect<void>;
}

/**
 * Port for command idempotency. The bus claims `(tag, actor, key)` before
 * running the handler, records the encoded success on completion and
 * releases the claim on failure. Results are stored in their wire form,
 * so durable implementations only ever hold JSON. This bus suppresses
 * replays and duplicate concurrent runs of one key; durable exactly-once
 * processing of *events* belongs to an event-sourcing inbox, not here.
 */
export class IdempotencyStore extends Context.Tag("@structure-ai/cqrs/IdempotencyStore")<
  IdempotencyStore,
  IdempotencyStoreService
>() {
  /**
   * Process-local store; entries live for the lifetime of the layer. Use a
   * durable implementation (e.g. `@structure-ai/eventsourcing-pg`) for
   * idempotency across restarts or instances.
   */
  static readonly inMemory: Layer.Layer<IdempotencyStore> = Layer.sync(IdempotencyStore, () => {
    type Record =
      | { readonly state: "claimed"; readonly payloadHash: string }
      | { readonly state: "completed"; readonly payloadHash: string; readonly result: unknown };
    const records = new Map<string, Record>();
    const compositeKey = (context: IdempotencyContext): string =>
      `${context.tag}\u0000${context.actor ?? ""}\u0000${context.key}`;
    return {
      begin: (context) =>
        Effect.sync(() => {
          const id = compositeKey(context);
          const existing = records.get(id);
          if (existing === undefined) {
            records.set(id, { state: "claimed", payloadHash: context.payloadHash });
            return BeginOutcome.Claimed();
          }
          if (existing.payloadHash !== context.payloadHash) return BeginOutcome.Mismatch();
          return existing.state === "claimed"
            ? BeginOutcome.InFlight()
            : BeginOutcome.Completed({ result: existing.result });
        }),
      complete: (context, result) =>
        Effect.sync(() => {
          records.set(compositeKey(context), {
            state: "completed",
            payloadHash: context.payloadHash,
            result,
          });
        }),
      release: (context) =>
        Effect.sync(() => {
          const id = compositeKey(context);
          if (records.get(id)?.state === "claimed") records.delete(id);
        }),
    };
  });
}

const formatIssues = (error: ParseError): ReadonlyArray<string> =>
  ArrayFormatter.formatErrorSync(error).map((issue) =>
    issue.path.length === 0 ? issue.message : `${issue.path.join(".")}: ${issue.message}`,
  );

/** Reduces a tag to the character set metric backends accept. */
const metricName = (kind: MessageKind, tag: string): string =>
  `cqrs_${kind}_${tag.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;

/** Rebuilds a JSON value with object keys sorted (recursively), dropping `undefined` members. */
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const source = value as Readonly<Record<string, unknown>>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const member = source[key];
    if (member !== undefined) sorted[key] = canonical(member);
  }
  return sorted;
};

/** Stable JSON text of a wire value; key order never changes the output. */
const stableJson = (value: unknown): string =>
  JSON.stringify(canonical(value), (_key, member: unknown) =>
    typeof member === "bigint" ? member.toString() : member,
  ) ?? "null";

/** Lowercase hex sha-256 of the text (web crypto — Bun, Node and browsers). */
const sha256Hex = (text: string): Effect.Effect<string> =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).pipe(
    Effect.map((digest) =>
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    ),
  );

/**
 * Runs `execute` under the idempotency protocol: encode the payload to its
 * wire form and hash it, claim `(tag, actor, key)`, then either replay the
 * recorded success (decoded back to the domain type), refuse, or run the
 * handler and record its encoded success — releasing the claim if the run
 * fails, times out or is interrupted.
 */
const idempotent = <PayloadType, PayloadEncoded, SuccessType, SuccessEncoded, E>(
  store: IdempotencyStoreService,
  definition: {
    readonly tag: string;
    readonly payload: Schema.Schema<PayloadType, PayloadEncoded>;
    readonly success: Schema.Schema<SuccessType, SuccessEncoded>;
  },
  key: string,
  actor: string | undefined,
  payload: PayloadType,
  execute: Effect.Effect<SuccessType, E>,
): Effect.Effect<SuccessType, E | IdempotencyMismatch | IdempotencyInFlight> =>
  Effect.gen(function* () {
    // The definition's schemas decoded this payload, so encoding it back
    // cannot fail short of a schema that is not round-trippable (a defect).
    const encodedPayload = yield* Schema.encode(definition.payload)(payload).pipe(Effect.orDie);
    const payloadHash = yield* sha256Hex(stableJson(encodedPayload));
    const context: IdempotencyContext = {
      key,
      tag: definition.tag,
      payloadHash,
      ...(actor !== undefined && { actor }),
    };
    const outcome = yield* store.begin(context);
    switch (outcome._tag) {
      case "Completed":
        return yield* Schema.decodeUnknown(definition.success)(outcome.result).pipe(Effect.orDie);
      case "InFlight":
        return yield* Effect.fail(new IdempotencyInFlight({ tag: definition.tag, key }));
      case "Mismatch":
        return yield* Effect.fail(new IdempotencyMismatch({ tag: definition.tag, key }));
      case "Claimed": {
        const completed = yield* Effect.gen(function* () {
          const result = yield* execute;
          const encoded = yield* Schema.encode(definition.success)(result).pipe(Effect.orDie);
          return { result, encoded };
        }).pipe(Effect.onError(() => store.release(context)));
        yield* store.complete(context, completed.encoded);
        return completed.result;
      }
    }
  });

const makeDispatch = (
  kind: MessageKind,
  registry: ReadonlyMap<string, Registration>,
  authorizer: Context.Tag.Service<Authorizer>,
  store: Option.Option<IdempotencyStoreService>,
) => {
  const boundaries = new Map<string, Metrics.BoundaryMetrics>();
  const boundaryFor = (name: string): Metrics.BoundaryMetrics => {
    const existing = boundaries.get(name);
    if (existing !== undefined) return existing;
    const created = Metrics.boundary(name);
    boundaries.set(name, created);
    return created;
  };

  return <
    Tag extends string,
    PayloadType,
    PayloadEncoded,
    SuccessType,
    SuccessEncoded,
    FailureType,
    FailureEncoded,
  >(
    definition: MessageDefinition<
      MessageKind,
      Tag,
      PayloadType,
      PayloadEncoded,
      SuccessType,
      SuccessEncoded,
      FailureType,
      FailureEncoded
    >,
    input: PayloadEncoded,
    options?: DispatchOptions,
  ): Effect.Effect<SuccessType, DispatchError | FailureType> =>
    Effect.gen(function* () {
      const registration = registry.get(definition.tag);
      if (registration === undefined || registration.definition._kind !== definition._kind) {
        return yield* Effect.fail(
          new HandlerNotFound({ tag: definition.tag, kind: definition._kind }),
        );
      }

      // 1. Boundary validation: shape only; business rules live in the domain.
      const payload = yield* Schema.decodeUnknown(definition.payload, { errors: "all" })(
        input,
      ).pipe(
        Effect.mapError(
          (error) => new ValidationFailed({ subject: definition.tag, issues: formatIssues(error) }),
        ),
      );

      const parent = yield* Correlation.current;
      const messageId = crypto.randomUUID();
      const correlationId = parent.correlationId ?? crypto.randomUUID();
      const actor = options?.actor ?? parent.actor;
      const envelope: Dispatch = {
        messageId,
        correlationId,
        ...(parent.causationId !== undefined && { causationId: parent.causationId }),
        ...(actor !== undefined && { actor }),
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      };

      // 2. Authorization on the action, before the handler and the cache.
      yield* authorizer.authorize({
        tag: definition.tag,
        kind: definition._kind,
        payload,
        ...(actor !== undefined && { actor }),
      });

      // The registration was produced by CommandHandler.make/QueryHandler.make
      // against this definition, so its erased types are the definition's.
      const handled = registration.handler(payload, envelope) as Effect.Effect<
        SuccessType,
        FailureType
      >;

      const timeout = options?.timeout;
      const limited =
        timeout === undefined
          ? handled
          : handled.pipe(
              Effect.timeoutFail({
                duration: timeout,
                onTimeout: () =>
                  new DispatchTimeout({
                    tag: definition.tag,
                    timeoutMillis: Duration.toMillis(timeout),
                  }),
              }),
            );

      // 4. Every executed dispatch is traced and measured; the handler runs
      // in a correlation scope naming this message as the cause.
      const metric = metricName(kind, definition.tag);
      const traced = limited.pipe(
        Metrics.track(metric, boundaryFor(metric)),
        Effect.withSpan(`cqrs.${kind}.${definition.tag}`),
        Correlation.within({
          correlationId,
          causationId: messageId,
          ...(actor !== undefined && { actor }),
        }),
      );

      // 3. Idempotency, commands only: the key is claimed for this actor and
      // payload before the handler runs; a completed key short-circuits to
      // the recorded success without re-running (or re-tracing) anything.
      const key = options?.idempotencyKey;
      if (kind === "command" && key !== undefined && Option.isSome(store)) {
        return yield* idempotent(store.value, definition, key, actor, payload, traced);
      }

      return yield* traced;
    });
};

/** Service surface of the command bus. */
export interface CommandBusService {
  /**
   * Runs the pipeline for one command: decode payload (`ValidationFailed`
   * on bad shape), authorize the action, claim the idempotency key when one
   * is given (scoped to the actor, bound to the payload), then execute the
   * single registered handler traced, measured and under the optional
   * timeout.
   */
  readonly dispatch: <
    Tag extends string,
    PayloadType,
    PayloadEncoded,
    SuccessType,
    SuccessEncoded,
    FailureType,
    FailureEncoded,
  >(
    definition: CommandDefinition<
      Tag,
      PayloadType,
      PayloadEncoded,
      SuccessType,
      SuccessEncoded,
      FailureType,
      FailureEncoded
    >,
    input: PayloadEncoded,
    options?: DispatchOptions,
  ) => Effect.Effect<SuccessType, DispatchError | FailureType>;
}

/** Service surface of the query bus. */
export interface QueryBusService {
  /**
   * Runs the pipeline for one query: decode, authorize, execute traced and
   * measured under the optional timeout. Queries get no idempotency
   * handling — they must not change state, so replays are harmless.
   */
  readonly dispatch: <
    Tag extends string,
    PayloadType,
    PayloadEncoded,
    SuccessType,
    SuccessEncoded,
    FailureType,
    FailureEncoded,
  >(
    definition: QueryDefinition<
      Tag,
      PayloadType,
      PayloadEncoded,
      SuccessType,
      SuccessEncoded,
      FailureType,
      FailureEncoded
    >,
    input: PayloadEncoded,
    options?: DispatchOptions,
  ) => Effect.Effect<SuccessType, DispatchError | FailureType>;
}

const makeCommandBus: Effect.Effect<
  CommandBusService,
  never,
  HandlerRegistry | Authorizer | IdempotencyStore
> = Effect.gen(function* () {
  const registry = yield* HandlerRegistry;
  const authorizer = yield* Authorizer;
  const store = yield* IdempotencyStore;
  return { dispatch: makeDispatch("command", registry, authorizer, Option.some(store)) };
});

const makeQueryBus: Effect.Effect<QueryBusService, never, HandlerRegistry | Authorizer> =
  Effect.gen(function* () {
    const registry = yield* HandlerRegistry;
    const authorizer = yield* Authorizer;
    return { dispatch: makeDispatch("query", registry, authorizer, Option.none()) };
  });

/** Dispatches commands through the middleware pipeline. */
export class CommandBus extends Context.Tag("@structure-ai/cqrs/CommandBus")<
  CommandBus,
  CommandBusService
>() {
  static readonly layer: Layer.Layer<
    CommandBus,
    never,
    HandlerRegistry | Authorizer | IdempotencyStore
  > = Layer.effect(CommandBus, makeCommandBus);
}

/** Dispatches queries through the middleware pipeline (no idempotency). */
export class QueryBus extends Context.Tag("@structure-ai/cqrs/QueryBus")<
  QueryBus,
  QueryBusService
>() {
  static readonly layer: Layer.Layer<QueryBus, never, HandlerRegistry | Authorizer> = Layer.effect(
    QueryBus,
    makeQueryBus,
  );
}

/**
 * Both buses with the default middleware services (allow-all authorizer,
 * in-memory idempotency store). Provide `HandlerRegistry.layer(...)` to
 * finish the stack; override `Authorizer`/`IdempotencyStore` by building
 * the bus layers yourself instead.
 */
export const layer: Layer.Layer<CommandBus | QueryBus, never, HandlerRegistry> = Layer.mergeAll(
  CommandBus.layer,
  QueryBus.layer,
).pipe(Layer.provide(Layer.mergeAll(Authorizer.allowAll, IdempotencyStore.inMemory)));
