import { describe, expect, test } from "bun:test";
import { ValidationFailed } from "@structure-ai/domain";
import { Correlation } from "@structure-ai/observability";
import { Deferred, Effect, Fiber, Layer, Ref, Schema } from "effect";
import {
  Authorizer,
  BeginOutcome,
  layer as busLayer,
  Command,
  CommandBus,
  CommandHandler,
  DispatchTimeout,
  HandlerNotFound,
  HandlerRegistry,
  type IdempotencyContext,
  IdempotencyInFlight,
  IdempotencyMismatch,
  IdempotencyStore,
  Query,
  QueryBus,
  QueryHandler,
  type Registration,
  Unauthorized,
} from "../src/index.js";

const Deposit = Command.define("DepositFunds", {
  payload: Schema.Struct({ amount: Schema.Number }),
  success: Schema.Struct({ balance: Schema.Number }),
});

const Transfer = Command.define("TransferFunds", {
  payload: Schema.Struct({ from: Schema.String, amount: Schema.Number }),
  success: Schema.Struct({ transferred: Schema.Number }),
});

const GetBalance = Query.define("GetBalance", {
  payload: Schema.Struct({ account: Schema.String }),
  success: Schema.Struct({ balance: Schema.Number }),
});

/** Full default stack (allow-all authorizer, in-memory idempotency). */
const stack = (...registrations: ReadonlyArray<Registration>) =>
  busLayer.pipe(Layer.provide(HandlerRegistry.layer(...registrations)));

const run = <A, E>(
  layer: Layer.Layer<CommandBus | QueryBus>,
  effect: Effect.Effect<A, E, CommandBus | QueryBus>,
) => Effect.runPromise(effect.pipe(Effect.provide(layer)));

describe("CommandBus", () => {
  test("typed roundtrip: dispatch decodes the payload and returns the handler success", async () => {
    const seen: Array<{ amount: number }> = [];
    let envelopeCorrelation = "";
    let envelopeMessageId = "";
    const registration = CommandHandler.make(Deposit, (payload, dispatch) => {
      seen.push(payload);
      envelopeCorrelation = dispatch.correlationId;
      envelopeMessageId = dispatch.messageId;
      return Effect.succeed({ balance: payload.amount * 2 });
    });

    const result = await run(
      stack(registration),
      Effect.gen(function* () {
        const bus = yield* CommandBus;
        return yield* bus.dispatch(Deposit, { amount: 21 });
      }),
    );

    expect(result).toEqual({ balance: 42 });
    expect(seen).toEqual([{ amount: 21 }]);
    expect(envelopeMessageId).not.toBe("");
    expect(envelopeCorrelation).not.toBe("");
  });

  test("boundary validation: a bad payload fails with ValidationFailed and the handler never runs", async () => {
    const program = Effect.gen(function* () {
      const invocations = yield* Ref.make(0);
      const registration = CommandHandler.make(Transfer, () =>
        Ref.update(invocations, (n) => n + 1).pipe(Effect.as({ transferred: 0 })),
      );
      const error = yield* Effect.gen(function* () {
        const bus = yield* CommandBus;
        return yield* bus
          .dispatch(Transfer, { from: 1, amount: "nope" } as unknown as {
            from: string;
            amount: number;
          })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(stack(registration)));
      return { error, count: yield* Ref.get(invocations) };
    });

    const { error, count } = await Effect.runPromise(program);
    expect(error).toBeInstanceOf(ValidationFailed);
    const failed = error as ValidationFailed;
    expect(failed.subject).toBe("TransferFunds");
    // errors: "all" — both bad fields are reported.
    expect(failed.issues.length).toBe(2);
    expect(count).toBe(0);
  });

  test("HandlerNotFound: dispatching a tag nobody registered fails", async () => {
    const registration = CommandHandler.make(Deposit, (payload) =>
      Effect.succeed({ balance: payload.amount }),
    );
    const error = await run(
      stack(registration),
      Effect.gen(function* () {
        const bus = yield* CommandBus;
        return yield* bus.dispatch(Transfer, { from: "a", amount: 1 }).pipe(Effect.flip);
      }),
    );
    expect(error).toBeInstanceOf(HandlerNotFound);
    expect((error as HandlerNotFound).tag).toBe("TransferFunds");
  });

  test("authorization: a custom Authorizer denies mallory and allows others", async () => {
    const denyMallory = Layer.succeed(Authorizer, {
      authorize: (request) =>
        request.actor === "mallory"
          ? Effect.fail(
              new Unauthorized({ tag: request.tag, actor: "mallory", reason: "blocklisted" }),
            )
          : Effect.void,
    });
    const registration = CommandHandler.make(Deposit, (payload) =>
      Effect.succeed({ balance: payload.amount }),
    );
    const layer = Layer.mergeAll(CommandBus.layer, QueryBus.layer).pipe(
      Layer.provide(
        Layer.mergeAll(HandlerRegistry.layer(registration), denyMallory, IdempotencyStore.inMemory),
      ),
    );

    const denied = await run(
      layer,
      Effect.gen(function* () {
        const bus = yield* CommandBus;
        return yield* bus.dispatch(Deposit, { amount: 5 }, { actor: "mallory" }).pipe(Effect.flip);
      }),
    );
    expect(denied).toBeInstanceOf(Unauthorized);
    expect((denied as Unauthorized).actor).toBe("mallory");

    const allowed = await run(
      layer,
      Effect.gen(function* () {
        const bus = yield* CommandBus;
        return yield* bus.dispatch(Deposit, { amount: 5 }, { actor: "alice" });
      }),
    );
    expect(allowed).toEqual({ balance: 5 });
  });

  test("idempotency: the same key runs the handler once and replays the cached success", async () => {
    const program = Effect.gen(function* () {
      const invocations = yield* Ref.make(0);
      const registration = CommandHandler.make(Deposit, (payload) =>
        Ref.updateAndGet(invocations, (n) => n + 1).pipe(
          Effect.map((n) => ({ balance: payload.amount + n })),
        ),
      );
      const results = yield* Effect.gen(function* () {
        const bus = yield* CommandBus;
        const first = yield* bus.dispatch(Deposit, { amount: 10 }, { idempotencyKey: "op-1" });
        const second = yield* bus.dispatch(Deposit, { amount: 10 }, { idempotencyKey: "op-1" });
        const other = yield* bus.dispatch(Deposit, { amount: 10 }, { idempotencyKey: "op-2" });
        return { first, second, other };
      }).pipe(Effect.provide(stack(registration)));
      return { ...results, count: yield* Ref.get(invocations) };
    });

    const { first, second, other, count } = await Effect.runPromise(program);
    expect(second).toEqual(first);
    expect(other).not.toEqual(first);
    expect(count).toBe(2);
  });

  test("timeout: a slow handler fails with DispatchTimeout", async () => {
    const registration = CommandHandler.make(Deposit, (payload) =>
      Effect.sleep("200 millis").pipe(Effect.as({ balance: payload.amount })),
    );
    const error = await run(
      stack(registration),
      Effect.gen(function* () {
        const bus = yield* CommandBus;
        return yield* bus
          .dispatch(Deposit, { amount: 1 }, { timeout: "10 millis" })
          .pipe(Effect.flip);
      }),
    );
    expect(error).toBeInstanceOf(DispatchTimeout);
    expect((error as DispatchTimeout).timeoutMillis).toBe(10);
    expect((error as DispatchTimeout).classification).toBe("transient");
  });
});

describe("QueryBus", () => {
  test("queries dispatch through the pipeline and ignore idempotency keys", async () => {
    const program = Effect.gen(function* () {
      const invocations = yield* Ref.make(0);
      const registration = QueryHandler.make(GetBalance, () =>
        Ref.updateAndGet(invocations, (n) => n + 1).pipe(Effect.map((n) => ({ balance: n }))),
      );
      const results = yield* Effect.gen(function* () {
        const bus = yield* QueryBus;
        const first = yield* bus.dispatch(GetBalance, { account: "a" }, { idempotencyKey: "same" });
        const second = yield* bus.dispatch(
          GetBalance,
          { account: "a" },
          { idempotencyKey: "same" },
        );
        return { first, second };
      }).pipe(Effect.provide(stack(registration)));
      return { ...results, count: yield* Ref.get(invocations) };
    });

    const { first, second, count } = await Effect.runPromise(program);
    // No caching for queries: the handler ran both times.
    expect(count).toBe(2);
    expect(first).toEqual({ balance: 1 });
    expect(second).toEqual({ balance: 2 });
  });

  test("a query cannot be answered by a command registration with the same tag", async () => {
    const ImpostorQuery = Query.define("DepositFunds", {
      payload: Schema.Struct({ amount: Schema.Number }),
      success: Schema.Struct({ balance: Schema.Number }),
    });
    const registration = CommandHandler.make(Deposit, (payload) =>
      Effect.succeed({ balance: payload.amount }),
    );
    const error = await run(
      stack(registration),
      Effect.gen(function* () {
        const bus = yield* QueryBus;
        return yield* bus.dispatch(ImpostorQuery, { amount: 1 }).pipe(Effect.flip);
      }),
    );
    expect(error).toBeInstanceOf(HandlerNotFound);
  });
});

describe("CommandBus idempotency scope", () => {
  const Order = Command.define("PlaceOrder", {
    payload: Schema.Struct({ sku: Schema.String, quantity: Schema.Number }),
    success: Schema.Struct({ orderId: Schema.String, placedAt: Schema.Date }),
  });

  /** Handler counting invocations and returning a distinct result each time. */
  const counting = () =>
    Effect.gen(function* () {
      const invocations = yield* Ref.make(0);
      const registration = CommandHandler.make(Order, () =>
        Ref.updateAndGet(invocations, (n) => n + 1).pipe(
          Effect.map((n) => ({ orderId: `order-${n}`, placedAt: new Date(1_700_000_000_000 + n) })),
        ),
      );
      return { registration, count: Ref.get(invocations) };
    });

  test("two actors, same key, same tag: two independent executions", async () => {
    const program = Effect.gen(function* () {
      const { registration, count } = yield* counting();
      const results = yield* Effect.gen(function* () {
        const bus = yield* CommandBus;
        const payload = { sku: "sku-1", quantity: 1 };
        const alice = yield* bus.dispatch(Order, payload, { idempotencyKey: "k", actor: "alice" });
        const bob = yield* bus.dispatch(Order, payload, { idempotencyKey: "k", actor: "bob" });
        const aliceAgain = yield* bus.dispatch(Order, payload, {
          idempotencyKey: "k",
          actor: "alice",
        });
        return { alice, bob, aliceAgain };
      }).pipe(Effect.provide(stack(registration)));
      return { ...results, count: yield* count };
    });

    const { alice, bob, aliceAgain, count } = await Effect.runPromise(program);
    expect(count).toBe(2);
    expect(bob.orderId).not.toBe(alice.orderId);
    expect(aliceAgain).toEqual(alice);
    expect(aliceAgain.placedAt).toBeInstanceOf(Date);
  });

  test("the ambient correlation actor scopes the key like an explicit one", async () => {
    const program = Effect.gen(function* () {
      const { registration, count } = yield* counting();
      const results = yield* Effect.gen(function* () {
        const bus = yield* CommandBus;
        const payload = { sku: "sku-1", quantity: 1 };
        const explicit = yield* bus.dispatch(Order, payload, { idempotencyKey: "k", actor: "ada" });
        const ambient = yield* bus
          .dispatch(Order, payload, { idempotencyKey: "k" })
          .pipe(Correlation.within({ actor: "ada" }));
        const anonymous = yield* bus.dispatch(Order, payload, { idempotencyKey: "k" });
        return { explicit, ambient, anonymous };
      }).pipe(Effect.provide(stack(registration)));
      return { ...results, count: yield* count };
    });

    const { explicit, ambient, anonymous, count } = await Effect.runPromise(program);
    expect(ambient).toEqual(explicit);
    expect(anonymous.orderId).not.toBe(explicit.orderId);
    expect(count).toBe(2);
  });

  test("same actor, same key, different payload: IdempotencyMismatch, handler not run", async () => {
    const program = Effect.gen(function* () {
      const { registration, count } = yield* counting();
      const error = yield* Effect.gen(function* () {
        const bus = yield* CommandBus;
        yield* bus.dispatch(Order, { sku: "sku-1", quantity: 1 }, { idempotencyKey: "k" });
        return yield* bus
          .dispatch(Order, { sku: "sku-1", quantity: 2 }, { idempotencyKey: "k" })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(stack(registration)));
      return { error, count: yield* count };
    });

    const { error, count } = await Effect.runPromise(program);
    expect(error).toBeInstanceOf(IdempotencyMismatch);
    expect((error as IdempotencyMismatch).classification).toBe("conflict");
    expect((error as IdempotencyMismatch).key).toBe("k");
    expect((error as IdempotencyMismatch).tag).toBe("PlaceOrder");
    expect(count).toBe(1);
  });

  test("payload identity ignores key order: a reordered payload replays the cached result", async () => {
    const program = Effect.gen(function* () {
      const { registration, count } = yield* counting();
      const results = yield* Effect.gen(function* () {
        const bus = yield* CommandBus;
        const first = yield* bus.dispatch(
          Order,
          { sku: "sku-1", quantity: 1 },
          { idempotencyKey: "k" },
        );
        const second = yield* bus.dispatch(
          Order,
          { quantity: 1, sku: "sku-1" },
          { idempotencyKey: "k" },
        );
        return { first, second };
      }).pipe(Effect.provide(stack(registration)));
      return { ...results, count: yield* count };
    });

    const { first, second, count } = await Effect.runPromise(program);
    expect(second).toEqual(first);
    expect(count).toBe(1);
  });

  test("concurrent same key: one execution, the other sees InFlight then the completed result", async () => {
    const program = Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const invocations = yield* Ref.make(0);
      const registration = CommandHandler.make(Order, () =>
        Effect.gen(function* () {
          const n = yield* Ref.updateAndGet(invocations, (i) => i + 1);
          yield* Deferred.await(gate);
          return { orderId: `order-${n}`, placedAt: new Date(0) };
        }),
      );
      const results = yield* Effect.gen(function* () {
        const bus = yield* CommandBus;
        const payload = { sku: "sku-1", quantity: 1 };
        const first = yield* Effect.fork(bus.dispatch(Order, payload, { idempotencyKey: "k" }));
        // Let the first dispatch claim the key before the second arrives.
        yield* Effect.sleep("20 millis");
        const inFlight = yield* bus
          .dispatch(Order, payload, { idempotencyKey: "k" })
          .pipe(Effect.flip);
        yield* Deferred.succeed(gate, undefined);
        const completed = yield* Fiber.join(first);
        const replayed = yield* bus.dispatch(Order, payload, { idempotencyKey: "k" });
        return { inFlight, completed, replayed };
      }).pipe(Effect.provide(stack(registration)));
      return { ...results, count: yield* Ref.get(invocations) };
    });

    const { inFlight, completed, replayed, count } = await Effect.runPromise(program);
    expect(inFlight).toBeInstanceOf(IdempotencyInFlight);
    expect((inFlight as IdempotencyInFlight).classification).toBe("transient");
    expect(replayed).toEqual(completed);
    expect(count).toBe(1);
  });

  test("a failed dispatch releases the claim so a retry runs the handler again", async () => {
    class Rejected extends Schema.TaggedError<Rejected>()("Rejected", {
      reason: Schema.String,
    }) {}
    const FlakyOrder = Command.define("PlaceFlakyOrder", {
      payload: Schema.Struct({ sku: Schema.String }),
      success: Schema.Struct({ orderId: Schema.String }),
      failure: Rejected,
    });
    const program = Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const registration = CommandHandler.make(FlakyOrder, () =>
        Ref.updateAndGet(attempts, (n) => n + 1).pipe(
          Effect.flatMap((n) =>
            n === 1
              ? Effect.fail(new Rejected({ reason: "first attempt fails" }))
              : Effect.succeed({ orderId: `order-${n}` }),
          ),
        ),
      );
      const results = yield* Effect.gen(function* () {
        const bus = yield* CommandBus;
        const payload = { sku: "sku-1" };
        const failed = yield* bus
          .dispatch(FlakyOrder, payload, { idempotencyKey: "k" })
          .pipe(Effect.flip);
        const retried = yield* bus.dispatch(FlakyOrder, payload, { idempotencyKey: "k" });
        return { failed, retried };
      }).pipe(Effect.provide(stack(registration)));
      return { ...results, count: yield* Ref.get(attempts) };
    });

    const { failed, retried, count } = await Effect.runPromise(program);
    expect(failed).toBeInstanceOf(Rejected);
    expect(retried.orderId).toBe("order-2");
    expect(count).toBe(2);
  });

  test("the store sees actor, tag, a sha-256 payload hash and the encoded success", async () => {
    const seen: Array<IdempotencyContext> = [];
    const completed: Array<unknown> = [];
    const spy = Layer.succeed(IdempotencyStore, {
      begin: (context) =>
        Effect.sync(() => {
          seen.push(context);
          return BeginOutcome.Claimed();
        }),
      complete: (_context, result) =>
        Effect.sync(() => {
          completed.push(result);
        }),
      release: () => Effect.void,
    });
    const registration = CommandHandler.make(Order, () =>
      Effect.succeed({ orderId: "order-1", placedAt: new Date("2026-01-01T00:00:00.000Z") }),
    );
    const layer = Layer.mergeAll(CommandBus.layer, QueryBus.layer).pipe(
      Layer.provide(Layer.mergeAll(HandlerRegistry.layer(registration), Authorizer.allowAll, spy)),
    );

    await run(
      layer,
      Effect.gen(function* () {
        const bus = yield* CommandBus;
        yield* bus.dispatch(
          Order,
          { sku: "sku-1", quantity: 1 },
          { idempotencyKey: "k", actor: "ada" },
        );
        yield* bus.dispatch(Order, { quantity: 1, sku: "sku-1" }, { idempotencyKey: "k" });
      }),
    );

    expect(seen.length).toBe(2);
    expect(seen[0]?.key).toBe("k");
    expect(seen[0]?.tag).toBe("PlaceOrder");
    expect(seen[0]?.actor).toBe("ada");
    expect(seen[1]?.actor).toBeUndefined();
    expect(seen[0]?.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(seen[1]?.payloadHash).toBe(seen[0]?.payloadHash ?? "");
    // The stored result is the wire (encoded) success, so durable stores hold JSON.
    expect(completed[0]).toEqual({ orderId: "order-1", placedAt: "2026-01-01T00:00:00.000Z" });
  });

  test("IdempotencyStore.inMemory implements the begin/complete/release contract", async () => {
    const context: IdempotencyContext = { key: "k", tag: "T", actor: "ada", payloadHash: "h1" };
    const outcomes = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* IdempotencyStore;
        const claimed = yield* store.begin(context);
        const inFlight = yield* store.begin(context);
        const mismatch = yield* store.begin({ ...context, payloadHash: "h2" });
        const otherActor = yield* store.begin({ ...context, actor: "bob" });
        yield* store.release(context);
        const reclaimed = yield* store.begin(context);
        yield* store.complete(context, { ok: true });
        const completed = yield* store.begin(context);
        // Releasing a completed record is a no-op: the result stays cached.
        yield* store.release(context);
        const still = yield* store.begin(context);
        return { claimed, inFlight, mismatch, otherActor, reclaimed, completed, still };
      }).pipe(Effect.provide(IdempotencyStore.inMemory)),
    );
    expect(outcomes.claimed._tag).toBe("Claimed");
    expect(outcomes.inFlight._tag).toBe("InFlight");
    expect(outcomes.mismatch._tag).toBe("Mismatch");
    expect(outcomes.otherActor._tag).toBe("Claimed");
    expect(outcomes.reclaimed._tag).toBe("Claimed");
    expect(outcomes.completed).toEqual({ _tag: "Completed", result: { ok: true } });
    expect(outcomes.still).toEqual({ _tag: "Completed", result: { ok: true } });
  });
});
