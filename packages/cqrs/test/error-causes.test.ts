import { expect, test } from "bun:test";
import { PersistenceError } from "@structure-ai/domain";
import { Cause, Effect, Exit, Layer, Schema } from "effect";
import {
  Authorizer,
  BeginOutcome,
  Command,
  CommandBus,
  CommandHandler,
  HandlerRegistry,
  IdempotencyStore,
} from "../src/index.js";

const command = Command.define("Save", { payload: Schema.Struct({}), success: Schema.String });

test("idempotency cleanup retains the dispatch failure, defect and cleanup failure", async () => {
  const failure = new PersistenceError({ operation: "save", cause: new Error("outage") });
  const cleanup = new PersistenceError({ operation: "release", cause: new Error("outage") });
  const defect = new Error("handler defect");
  const original = Cause.parallel(Cause.fail(failure), Cause.die(defect));
  const services = CommandBus.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Authorizer.allowAll,
        HandlerRegistry.layer(CommandHandler.make(command, () => Effect.failCause(original))),
        Layer.succeed(
          IdempotencyStore,
          IdempotencyStore.of({
            begin: () => Effect.succeed(BeginOutcome.Claimed()),
            complete: () => Effect.void,
            release: () => Effect.fail(cleanup),
          }),
        ),
      ),
    ),
  );
  const exit = await Effect.runPromiseExit(
    Effect.flatMap(CommandBus, (bus) => bus.dispatch(command, {}, { idempotencyKey: "key" })).pipe(
      Effect.provide(services),
    ),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit))
    expect(exit.cause).toEqual(Cause.sequential(original, Cause.fail(cleanup)));
});
