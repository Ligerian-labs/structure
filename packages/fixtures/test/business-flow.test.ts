import { expect, test } from "bun:test";
import { CommandBus, QueryBus } from "@structure-ai/cqrs";
import { Effect } from "effect";
import { cleanup, run } from "../src/index.js";
import {
  baseCms,
  baseUser,
  catalog,
  GetStock,
  lowStock,
  makeApp,
  ReserveStock,
} from "./business-app.js";

test("sales feature uses base user and CMS fixtures and exposes projected low stock", async () => {
  const app = makeApp();
  await Effect.runPromise(
    Effect.gen(function* () {
      const report = yield* run({
        fixtures: { user: baseUser, cms: baseCms, stock: lowStock(1) },
        enabled: true,
        ready: () => app.ready,
      });
      expect(app.references.size).toBe(2);
      const queries = yield* QueryBus;
      const commands = yield* CommandBus;
      const productId = report.values.stock.productId;
      expect(yield* queries.dispatch(GetStock, { productId })).toBe(1);
      // Exercise the feature against the prepared state: overselling fails the actual decider.
      const rejected = yield* commands
        .dispatch(ReserveStock, { productId, quantity: 2 })
        .pipe(Effect.either);
      expect(rejected._tag).toBe("Left");
      yield* commands.dispatch(ReserveStock, { productId, quantity: 1 });
      yield* app.ready;
      expect(yield* queries.dispatch(GetStock, { productId })).toBe(0);
      const second = yield* run({
        fixtures: yield* catalog.prepare("sales/low-stock", { remaining: 3 }),
        enabled: true,
        ready: () => app.ready,
      });
      yield* cleanup({ runId: report.runId, enabled: true, remove: app.cleanup });
      expect(app.references.size).toBe(2);
      expect(app.stocks.size).toBe(1);
      expect([...app.stocks.values()][0]?.runId).toBe(second.runId);
    }).pipe(Effect.provide(app.layer)),
  );
});
