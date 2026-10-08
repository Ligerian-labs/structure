import { EventStore, Projection } from "@structure-ai/eventsourcing";
import { Effect, Stream } from "effect";
import { layer } from "../../src/index.js";
import { counterRegistry } from "../fixtures.js";

const tablePrefix = process.argv[2];
const name = process.argv[3];
if (tablePrefix === undefined || name === undefined) throw new Error("missing worker arguments");

let reads = 0;
process.on("message", (message) => {
  if (message === "stats") process.send?.({ type: "stats", reads });
});

const program = Effect.gen(function* () {
  const store = yield* EventStore;
  const observed = EventStore.of({
    ...store,
    readAll: (options) => {
      reads++;
      let empty = true;
      return store.readAll(options).pipe(
        Stream.tap(() =>
          Effect.sync(() => {
            empty = false;
          }),
        ),
        Stream.ensuring(
          Effect.sync(() => {
            if (empty) process.send?.({ type: "idle", reads });
          }),
        ),
      );
    },
  });
  const projection = Projection.make({
    name,
    registry: counterRegistry,
    when: {
      Incremented: (_event, stored) =>
        Effect.sync(() => {
          process.send?.({ type: "event", position: String(stored.position) });
        }),
    },
  });
  yield* Projection.run(projection).pipe(Effect.provideService(EventStore, observed));
});

try {
  await Effect.runPromise(program.pipe(Effect.provide(layer({ tablePrefix })), Effect.scoped));
} catch {
  process.send?.({ type: "failed" });
  process.exitCode = 1;
}
