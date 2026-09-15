/** Executable example: app-owned state, commands, business decisions, and deferred query updates. */
import {
  Command,
  CommandBus,
  CommandHandler,
  HandlerRegistry,
  layer,
  Query,
  QueryHandler,
} from "@structure-ai/cqrs";
import { Aggregate, InvariantViolation } from "@structure-ai/domain";
import { Effect, Layer, Schema } from "effect";
import { defineFixture, defineScenario, makeCatalog } from "../src/index.js";

const quantity = Schema.Number.pipe(Schema.int(), Schema.positive());
const CreateReference = Command.define("CreateReference", {
  payload: Schema.Struct({
    id: Schema.UUID,
    runId: Schema.UUID,
    kind: Schema.Literal("user", "cms"),
    label: Schema.String,
  }),
  success: Schema.Struct({ id: Schema.UUID }),
});
const ReceiveStock = Command.define("ReceiveStock", {
  payload: Schema.Struct({ productId: Schema.UUID, runId: Schema.UUID, quantity }),
  success: Schema.Struct({ productId: Schema.UUID }),
  failure: Schema.instanceOf(InvariantViolation),
});
export const ReserveStock = Command.define("ReserveStock", {
  payload: Schema.Struct({ productId: Schema.UUID, quantity }),
  success: Schema.Struct({ productId: Schema.UUID }),
  failure: Schema.instanceOf(InvariantViolation),
});
export const GetStock = Query.define("GetStock", {
  payload: Schema.Struct({ productId: Schema.UUID }),
  success: Schema.Number,
});
const RemoveFixtureRun = Command.define("RemoveFixtureRun", {
  payload: Schema.Struct({ runId: Schema.UUID }),
  success: Schema.Void,
});

type Intent = { readonly kind: "receive" | "reserve"; readonly quantity: number };
type StockEvent = { readonly available: number };
const Stock = Aggregate.define<number, Intent, StockEvent, InvariantViolation>({
  name: "Stock",
  initial: 0,
  decide: (available, intent) =>
    intent.kind === "reserve" && intent.quantity > available
      ? Effect.fail(new InvariantViolation({ rule: "Cannot reserve more stock than is available" }))
      : Effect.succeed([
          {
            available: available + (intent.kind === "receive" ? intent.quantity : -intent.quantity),
          },
        ]),
  evolve: (_state, event) => event.available,
});

export const baseUser = defineFixture({
  key: "base/user",
  create: ({ dispatch, id, runId }) =>
    dispatch(CreateReference, {
      id: id("user"),
      runId,
      kind: "user" as const,
      label: `${id("user")}@example.test`,
    }),
});
export const baseCms = defineFixture({
  key: "base/cms",
  create: ({ dispatch, id, runId }) =>
    dispatch(CreateReference, {
      id: id("page"),
      runId,
      kind: "cms" as const,
      label: "Shipping policy",
    }),
});

export const lowStock = (remaining: number) => {
  const product = defineFixture({
    key: "stock/product",
    create: ({ dispatch, id, runId }) =>
      dispatch(ReceiveStock, { productId: id("product"), runId, quantity: remaining + 1 }),
  });
  return defineFixture({
    key: "stock/reservation",
    dependencies: { product, buyer: baseUser },
    create: ({ dispatch, dependencies }) =>
      dispatch(ReserveStock, { productId: dependencies.product.productId, quantity: 1 }),
  });
};
export const catalog = makeCatalog({
  base: { user: baseUser, cms: baseCms },
  scenarios: [
    defineScenario({
      name: "base",
      description: "User and CMS content",
      input: Schema.Struct({}),
      fixtures: () => ({}),
    }),
    defineScenario({
      name: "sales/low-stock",
      description: "A product with one reservation and configurable remaining stock",
      input: Schema.Struct({
        remaining: Schema.optionalWith(Schema.Number.pipe(Schema.int(), Schema.between(0, 100)), {
          default: () => 1,
        }),
      }),
      fixtures: ({ remaining }) => ({ stock: lowStock(remaining) }),
    }),
  ],
});

export const makeApp = () => {
  const references = new Map<string, { runId: string; kind: string }>();
  const stocks = new Map<string, { runId: string; available: number }>();
  const projected = new Map<string, number>();
  const pending: Array<{ productId: string; available: number }> = [];
  const handlers = HandlerRegistry.layer(
    CommandHandler.make(CreateReference, (input) =>
      Effect.sync(() => {
        references.set(input.id, input);
        return { id: input.id };
      }),
    ),
    CommandHandler.make(ReceiveStock, (input) =>
      Effect.gen(function* () {
        const result = yield* Aggregate.execute(
          Stock,
          stocks.get(input.productId)?.available ?? Stock.initial,
          { kind: "receive", quantity: input.quantity },
        );
        stocks.set(input.productId, { runId: input.runId, available: result.state });
        for (const event of result.events) pending.push({ productId: input.productId, ...event });
        return { productId: input.productId };
      }),
    ),
    CommandHandler.make(ReserveStock, (input) =>
      Effect.gen(function* () {
        const current = stocks.get(input.productId);
        if (current === undefined)
          return yield* new InvariantViolation({ rule: "Product must exist" });
        const result = yield* Aggregate.execute(Stock, current.available, {
          kind: "reserve",
          quantity: input.quantity,
        });
        stocks.set(input.productId, { ...current, available: result.state });
        for (const event of result.events) pending.push({ productId: input.productId, ...event });
        return { productId: input.productId };
      }),
    ),
    QueryHandler.make(GetStock, ({ productId }) =>
      Effect.sync(() => projected.get(productId) ?? 0),
    ),
    CommandHandler.make(RemoveFixtureRun, ({ runId }) =>
      Effect.sync(() => {
        for (const [id, record] of references) if (record.runId === runId) references.delete(id);
        const removed = new Set<string>();
        for (const [id, record] of stocks)
          if (record.runId === runId) {
            stocks.delete(id);
            projected.delete(id);
            removed.add(id);
          }
        for (let index = pending.length - 1; index >= 0; index--) {
          const event = pending[index];
          if (event !== undefined && removed.has(event.productId)) pending.splice(index, 1);
        }
      }),
    ),
  );
  return {
    references,
    stocks,
    projected,
    layer: layer.pipe(Layer.provide(handlers)),
    ready: Effect.sync(() => {
      for (const event of pending.splice(0)) projected.set(event.productId, event.available);
    }),
    cleanup: (runId: string) =>
      Effect.flatMap(CommandBus, (bus) => bus.dispatch(RemoveFixtureRun, { runId })),
  };
};
