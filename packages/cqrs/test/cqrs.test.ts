import { describe, expect, test } from "bun:test";
import { ValidationFailed } from "@structure/domain";
import { Effect, Layer, Ref, Schema } from "effect";
import {
  Authorizer,
  layer as busLayer,
  Command,
  CommandBus,
  CommandHandler,
  DispatchTimeout,
  HandlerNotFound,
  HandlerRegistry,
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
