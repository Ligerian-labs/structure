import { describe, expect, test } from "bun:test";
import * as SqlClient from "@effect/sql/SqlClient";
import {
  type CheckpointStore,
  EventRegistry,
  EventStore,
  type EventStoreService,
  type StoredEventMetadata,
} from "@structure/eventsourcing";
import { layer as sqliteStores } from "@structure/eventsourcing-sqlite";
import { Effect, Schema } from "effect";
import { createTableSql, ViewModel, ViewProjection, ViewStore } from "../src/index.js";

const AccountOpened = Schema.TaggedStruct("AccountOpened", {
  accountId: Schema.String,
  owner: Schema.String,
});
const MoneyDeposited = Schema.TaggedStruct("MoneyDeposited", {
  accountId: Schema.String,
  amount: Schema.Number,
});
type AccountEvent = typeof AccountOpened.Type | typeof MoneyDeposited.Type;

const registry = EventRegistry.make([
  { schema: AccountOpened, schemaVersion: 1 },
  { schema: MoneyDeposited, schemaVersion: 1 },
]);

const AccountBalance = ViewModel.define({
  name: "AccountBalance",
  fields: {
    id: Schema.String,
    owner: Schema.String,
    balance: Schema.Number,
  },
});

const makeProjection = (live: Array<boolean>) =>
  ViewProjection.make({
    name: "account-balance",
    view: AccountBalance,
    registry,
    when: {
      AccountOpened: (event, store, context) => {
        live.push(context.live);
        return store.upsert({ id: event.accountId, owner: event.owner, balance: 0 });
      },
      MoneyDeposited: (event, store, context) =>
        Effect.gen(function* () {
          live.push(context.live);
          const current = yield* Effect.orDie(store.get(event.accountId));
          yield* store.upsert({ ...current, balance: current.balance + event.amount });
        }),
    },
  });

const metadata = (aggregateId: string, version: number): StoredEventMetadata => ({
  eventId: `evt-${aggregateId}-${version}`,
  occurredAt: "2024-01-01T00:00:00.000Z",
  aggregateName: "account",
  aggregateId,
  aggregateVersion: version,
});

const append = (
  events: EventStoreService,
  accountId: string,
  expectedVersion: number,
  toAppend: ReadonlyArray<AccountEvent>,
) =>
  events.append(
    `account-${accountId}`,
    expectedVersion,
    toAppend.map((event, index) => ({
      ...registry.encode(event),
      metadata: metadata(accountId, expectedVersion + index + 1),
    })),
  );

const runWith = <A>(
  program: Effect.Effect<A, unknown, SqlClient.SqlClient | EventStore | CheckpointStore>,
): Promise<A> =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(sqliteStores({ filename: ":memory:" })),
      Effect.scoped,
    ) as Effect.Effect<A, unknown>,
  );

describe("ViewProjection", () => {
  test("catchup hydrates, resumes from the checkpoint, and rebuild replays with live:false", async () => {
    await runWith(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(createTableSql(AccountBalance));
        const events = yield* EventStore;
        const store = yield* ViewStore.make(AccountBalance);
        const live: Array<boolean> = [];
        const projection = makeProjection(live);

        yield* append(events, "a1", 0, [
          AccountOpened.make({ accountId: "a1", owner: "alice" }),
          MoneyDeposited.make({ accountId: "a1", amount: 100 }),
        ]);
        yield* append(events, "a2", 0, [AccountOpened.make({ accountId: "a2", owner: "bob" })]);

        const first = yield* projection.catchup();
        expect(first).toEqual({ processed: 3, skipped: 0 });
        expect((yield* store.get("a1")).balance).toBe(100);
        expect((yield* store.get("a1")).owner).toBe("alice");
        expect((yield* store.get("a2")).balance).toBe(0);

        // Checkpoint resume: only the new event is applied — the balance
        // proves nothing was double-applied.
        yield* append(events, "a1", 2, [MoneyDeposited.make({ accountId: "a1", amount: 25 })]);
        const second = yield* projection.catchup();
        expect(second).toEqual({ processed: 1, skipped: 0 });
        expect((yield* store.get("a1")).balance).toBe(125);
        expect(live).toEqual([true, true, true, true]);

        // Corrupt a row, then rebuild: truncate + full replay with live:false.
        yield* sql`UPDATE account_balance SET balance = ${9999} WHERE id = ${"a1"}`;
        expect((yield* store.get("a1")).balance).toBe(9999);
        live.length = 0;
        const rebuilt = yield* projection.rebuild();
        expect(rebuilt).toEqual({ processed: 4, skipped: 0 });
        expect(live).toEqual([false, false, false, false]);
        expect((yield* store.get("a1")).balance).toBe(125);
        expect((yield* store.get("a2")).balance).toBe(0);

        // A later catchup after rebuild applies nothing new.
        const after = yield* projection.catchup();
        expect(after).toEqual({ processed: 0, skipped: 0 });
      }),
    );
  });

  test("event types unknown to the registry are skipped", async () => {
    await runWith(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(createTableSql(AccountBalance));
        const events = yield* EventStore;
        const store = yield* ViewStore.make(AccountBalance);
        const projection = makeProjection([]);

        yield* append(events, "a1", 0, [AccountOpened.make({ accountId: "a1", owner: "alice" })]);
        yield* events.append("legacy-x", 0, [
          {
            type: "SomethingUnknown",
            schemaVersion: 1,
            payload: { anything: true },
            metadata: metadata("x", 1),
          },
        ]);
        yield* append(events, "a1", 1, [MoneyDeposited.make({ accountId: "a1", amount: 7 })]);

        const stats = yield* projection.catchup();
        expect(stats).toEqual({ processed: 2, skipped: 1 });
        expect((yield* store.get("a1")).balance).toBe(7);
        expect(yield* store.count()).toBe(1);
      }),
    );
  });
});
