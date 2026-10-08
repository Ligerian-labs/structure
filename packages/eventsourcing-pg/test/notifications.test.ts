import { describe, expect, test } from "bun:test";
import * as SqlClient from "@effect/sql/SqlClient";
import { PgClient } from "@effect/sql-pg";
import { PersistenceError } from "@structure-ai/domain";
import {
  EventBus,
  EventStore,
  HistoryImport,
  HistoryImporter,
  Outbox,
} from "@structure-ai/eventsourcing";
import {
  Deferred,
  Effect,
  Either,
  Fiber,
  Layer,
  Option,
  Queue,
  Redacted,
  type Scope,
} from "effect";
import * as Pg from "pg";
import {
  type AdapterOptions,
  appendWithOutbox,
  eventBusLayer,
  eventStoreLayer,
  layer,
  migrate,
  migrations,
  type StoreServices,
  storesLayer,
  tableNames,
  withUnitOfWork,
} from "../src/index.js";
import { notificationFunctionName } from "../src/notifications.js";
import { counterRegistry, testMetadata } from "./fixtures.js";

const databaseUrl = process.env.DATABASE_URL;

const event = (version: number) => ({
  type: "Incremented",
  schemaVersion: 1,
  payload: { _tag: "Incremented", amount: version },
  metadata: testMetadata(version),
});

type TestServices =
  | StoreServices
  | EventBus
  | SqlClient.SqlClient
  | PgClient.PgClient
  | Scope.Scope;

const runScenario = (
  scenario: (options: AdapterOptions) => Effect.Effect<void, unknown, TestServices>,
) => {
  const tablePrefix = `n${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}_`;
  const tables = tableNames({ tablePrefix });
  return Effect.runPromise(
    Effect.scoped(scenario({ tablePrefix })).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          for (const table of Object.values(tables)) yield* sql`DROP TABLE IF EXISTS ${sql(table)}`;
          yield* sql`DROP FUNCTION IF EXISTS ${sql(notificationFunctionName(tables.events))}()`;
        }).pipe(Effect.orDie),
      ),
      Effect.provide(
        layer({
          ...(databaseUrl === undefined ? {} : { url: databaseUrl }),
          tablePrefix,
          maxConnections: 4,
          applicationName: tablePrefix,
        }),
      ),
      Effect.scoped,
    ),
  );
};

const noSignal = (wait: Effect.Effect<void, PersistenceError>) =>
  Effect.gen(function* () {
    const signal = yield* wait.pipe(Effect.timeoutOption("50 millis"));
    expect(Option.isNone(signal)).toBe(true);
  });

const spawnWorker = (options: AdapterOptions, name: string) =>
  Effect.gen(function* () {
    const messages = yield* Queue.unbounded<unknown>();
    const process = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.spawn({
          cmd: [
            globalThis.process.execPath,
            "run",
            new URL("./fixtures/notification-worker.ts", import.meta.url).pathname,
            options.tablePrefix ?? "",
            name,
          ],
          env: globalThis.process.env,
          ipc: (message) => {
            messages.unsafeOffer(message);
          },
          stdout: "ignore",
          stderr: "pipe",
        }),
      ),
      (child) =>
        Effect.promise(async () => {
          child.kill("SIGTERM");
          await child.exited;
        }).pipe(
          Effect.timeoutOption("1 second"),
          Effect.flatMap((exit) =>
            Option.isSome(exit) ? Effect.void : Effect.sync(() => child.kill("SIGKILL")),
          ),
          Effect.asVoid,
        ),
    );
    const receive = (type: string): Effect.Effect<Record<string, unknown>> =>
      Effect.gen(function* () {
        while (true) {
          const message = yield* Queue.take(messages);
          if (typeof message !== "object" || message === null || !("type" in message)) continue;
          if (message.type === "failed") return yield* Effect.die("projection subprocess failed");
          if (message.type === type) return message as Record<string, unknown>;
        }
      });
    return { process, receive };
  });

describe.skipIf(databaseUrl === undefined)("PostgreSQL commit notifications", () => {
  test("prefixed feeds have independent channels and manual notifications reach peer buses", async () => {
    await runScenario((options) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const firstStore = yield* EventStore;
        const firstBus = yield* EventBus;
        const firstWait = yield* firstBus.subscribe;
        const other = { tablePrefix: `${options.tablePrefix ?? ""}other_` };
        const tables = tableNames(other);
        yield* migrate(other);
        yield* Effect.gen(function* () {
          const otherStore = yield* EventStore.pipe(Effect.provide(eventStoreLayer(other)));
          const otherBus = yield* EventBus;
          const otherWait = yield* otherBus.subscribe;
          yield* firstStore.append("Counter-first", 0, [event(1)]);
          yield* firstWait.pipe(Effect.timeout("1 second"));
          yield* noSignal(otherWait);
          yield* otherStore.append("Counter-other", 0, [event(1)]);
          yield* otherWait.pipe(Effect.timeout("1 second"));
          yield* noSignal(firstWait);
          yield* otherBus.notify;
          yield* otherWait.pipe(Effect.timeout("1 second"));
          yield* noSignal(firstWait);
        }).pipe(
          Effect.provide(eventBusLayer(other)),
          Effect.ensuring(
            Effect.gen(function* () {
              for (const table of Object.values(tables))
                yield* sql`DROP TABLE IF EXISTS ${sql(table)}`;
              yield* sql`DROP FUNCTION IF EXISTS ${sql(notificationFunctionName(tables.events))}()`;
            }).pipe(Effect.orDie),
          ),
        );
      }),
    );
  });

  test("revision 5 upgrades a revision 4 database without losing history and rejects unmigrated listeners", async () => {
    const tablePrefix = `n${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}_`;
    const options = { tablePrefix };
    const tables = tableNames(options);
    const client = PgClient.layer({ url: Redacted.make(databaseUrl ?? "") });
    const oldSchema = Layer.effectDiscard(
      Effect.forEach(
        migrations.filter((migration) => migration.rev < 5),
        (migration) => migration.apply(options),
        { discard: true },
      ),
    ).pipe(Layer.provideMerge(client));
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = yield* EventStore;
        yield* store.append("Counter-upgrade", 0, [event(1)]);
        const unavailable = yield* Effect.either(
          EventBus.pipe(Effect.provide(eventBusLayer(options))),
        );
        expect(Either.isLeft(unavailable) && unavailable.left instanceof PersistenceError).toBe(
          true,
        );
        const revision = migrations.find((migration) => migration.rev === 5);
        if (revision === undefined) return yield* Effect.die("missing revision 5");
        yield* revision.apply(options);
        yield* revision.apply(options);
        yield* Effect.gen(function* () {
          const wait = yield* (yield* EventBus).subscribe;
          yield* store.append("Counter-upgrade", 1, [event(2)]);
          yield* wait.pipe(Effect.timeout("1 second"));
          const count = yield* sql<{
            readonly n: string;
          }>`SELECT count(*) AS n FROM ${sql(tables.events)}`;
          expect(Number(count[0]?.n)).toBe(2);
        }).pipe(Effect.provide(eventBusLayer(options)));
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            for (const table of Object.values(tables))
              yield* sql`DROP TABLE IF EXISTS ${sql(table)}`;
            yield* sql`DROP FUNCTION IF EXISTS ${sql(notificationFunctionName(tables.events))}()`;
          }).pipe(Effect.orDie),
        ),
        Effect.provide(storesLayer(options).pipe(Layer.provideMerge(oldSchema))),
        Effect.scoped,
      ),
    );
  });

  test("a spawned projection process receives live writes, performs no idle polling, and resumes from its checkpoint", async () => {
    await runScenario((options) =>
      Effect.gen(function* () {
        const store = yield* EventStore;
        yield* store.append("Counter-child", 0, [event(1)]);
        const worker = yield* spawnWorker(options, "child-projection");
        expect((yield* worker.receive("event")).position).toBe("1");
        const idle = yield* worker.receive("idle");
        yield* Effect.sleep("600 millis");
        worker.process.send("stats");
        expect((yield* worker.receive("stats")).reads).toBe(idle.reads);

        yield* store.append("Counter-child", 1, [event(2)]);
        expect((yield* worker.receive("event")).position).toBe("2");
        yield* worker.receive("idle");
        worker.process.kill("SIGTERM");
        yield* Effect.promise(() => worker.process.exited);

        yield* store.append("Counter-child", 2, [event(3)]);
        const restarted = yield* spawnWorker(options, "child-projection");
        expect((yield* restarted.receive("event")).position).toBe("3");
        yield* restarted.receive("idle");
      }).pipe(Effect.timeout("10 seconds")),
    );
  });

  test("notifications wait for the outer commit and disappear on transaction or savepoint rollback", async () => {
    await runScenario(() =>
      Effect.gen(function* () {
        const store = yield* EventStore;
        const bus = yield* EventBus;
        const wait = yield* bus.subscribe;
        const appended = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const writer = yield* withUnitOfWork(
          Effect.gen(function* () {
            yield* store.append("Counter-held", 0, [event(1)]);
            yield* Deferred.succeed(appended, undefined);
            yield* Deferred.await(release);
          }),
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(appended);
        yield* noSignal(wait);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(writer);
        yield* wait.pipe(Effect.timeout("1 second"));

        const rollback = yield* Effect.either(
          withUnitOfWork(
            store
              .append("Counter-rollback", 0, [event(1)])
              .pipe(Effect.andThen(Effect.fail("rollback"))),
          ),
        );
        expect(Either.isLeft(rollback)).toBe(true);
        yield* noSignal(wait);
        yield* withUnitOfWork(
          Effect.gen(function* () {
            yield* Effect.either(
              withUnitOfWork(
                store
                  .append("Counter-savepoint", 0, [event(1)])
                  .pipe(Effect.andThen(Effect.fail("rollback"))),
              ),
            );
          }),
        );
        yield* noSignal(wait);
      }),
    );
  });

  test("a committed event wakes workers even if its workflow fails afterwards", async () => {
    await runScenario(() =>
      Effect.gen(function* () {
        const store = yield* EventStore;
        const wait = yield* (yield* EventBus).subscribe;
        const workflow = yield* Effect.either(
          store
            .append("Counter-partial", 0, [event(1)])
            .pipe(Effect.andThen(Effect.fail("later failure"))),
        );
        expect(Either.isLeft(workflow)).toBe(true);
        yield* wait.pipe(Effect.timeout("1 second"));
      }),
    );
  });

  test("outbox appends, raw SQL inserts and history imports signal automatically", async () => {
    await runScenario((options) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const tables = tableNames(options);
        const wait = yield* (yield* EventBus).subscribe;
        const importer = yield* HistoryImporter;
        const imported = [{ ...event(1), position: 1n, version: 1, streamName: "Counter-import" }];
        const batch = {
          importId: "notifications",
          batchId: "one",
          events: imported,
          checksum: yield* HistoryImport.checksum(imported),
          complete: true,
        };
        yield* importer.importBatch(batch, counterRegistry);
        yield* wait.pipe(Effect.timeout("1 second"));
        yield* importer.importBatch(batch, counterRegistry);
        yield* noSignal(wait);
        yield* appendWithOutbox(
          "Counter-outbox",
          0,
          [event(1)],
          [{ id: "msg-1", topic: "counter", payload: {}, metadata: {} }],
          options,
        );
        yield* wait.pipe(Effect.timeout("1 second"));
        expect((yield* (yield* Outbox).pending(10)).length).toBe(1);
        yield* sql`INSERT INTO ${sql(tables.events)} (stream_name, version, type, schema_version, payload, metadata)
        VALUES ('Counter-raw', 1, 'Incremented', 1, '{"_tag":"Incremented","amount":1}'::jsonb, ${JSON.stringify(testMetadata(1))}::jsonb)`;
        yield* wait.pipe(Effect.timeout("1 second"));
        yield* sql`INSERT INTO ${sql(tables.events)} (stream_name, version, type, schema_version, payload, metadata)
        SELECT 'Counter-empty', 1, 'Incremented', 1, '{}'::jsonb, '{}'::jsonb WHERE FALSE`;
        yield* noSignal(wait);
      }),
    );
  });

  test("listener loss fails pending and future subscribers with a typed error", async () => {
    await runScenario((options) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const bus = yield* EventBus;
        const wait = yield* bus.subscribe;
        const pending = yield* Effect.either(wait).pipe(Effect.forkScoped);
        yield* Effect.yieldNow();
        yield* sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE application_name = ${`${options.tablePrefix ?? ""}/events`}`;
        const failed = yield* Fiber.join(pending).pipe(Effect.timeout("1 second"));
        expect(Either.isLeft(failed) && failed.left instanceof PersistenceError).toBe(true);
        const future = yield* bus.subscribe;
        const failedAgain = yield* Effect.either(future.pipe(Effect.timeout("1 second")));
        expect(Either.isLeft(failedAgain) && failedAgain.left instanceof PersistenceError).toBe(
          true,
        );
      }),
    );
  });

  test("reapplying revision 5 is safe and listener scopes close their connection", async () => {
    await runScenario((options) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rev = migrations.find((migration) => migration.rev === 5);
        if (rev === undefined) return yield* Effect.die("missing revision 5");
        yield* rev.apply(options);
        yield* rev.apply(options);
        const nested = yield* Deferred.make<void>();
        const close = yield* Deferred.make<void>();
        const listener = yield* Effect.gen(function* () {
          yield* Deferred.succeed(nested, undefined);
          yield* Deferred.await(close);
        }).pipe(Effect.provide(eventBusLayer(options)), Effect.forkScoped);
        yield* Deferred.await(nested);
        const count = () => sql<{ readonly n: string }>`SELECT count(*) AS n FROM pg_stat_activity
        WHERE application_name = ${`${options.tablePrefix ?? ""}/events`}`;
        expect(Number((yield* count())[0]?.n)).toBe(2);
        yield* Deferred.succeed(close, undefined);
        yield* Fiber.join(listener);
        expect(Number((yield* count())[0]?.n)).toBe(1);
      }),
    );
  });

  test("committed appends notify an independent listener without an application wrapper", async () => {
    const tablePrefix = `n${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}_`;
    const tables = tableNames({ tablePrefix });
    const clientLayer = PgClient.layer({ url: Redacted.make(databaseUrl ?? "") });
    const migrated = Layer.effectDiscard(migrate({ tablePrefix })).pipe(
      Layer.provideMerge(clientLayer),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ readonly channel: string }>`
        SELECT 'structure_events_' || to_regclass(quote_ident(${tables.events}))::oid::text AS channel
      `;
        const channel = rows[0]?.channel;
        if (channel === undefined) return yield* Effect.die("missing event table");
        const signals = yield* Queue.unbounded<Pg.Notification>();
        const client = yield* Effect.acquireRelease(
          Effect.sync(() => new Pg.Client({ connectionString: databaseUrl })),
          (client) => Effect.promise(() => client.end()),
        );
        client.on("error", () => {});
        client.on("notification", (notification) => signals.unsafeOffer(notification));
        yield* Effect.promise(() => client.connect());
        yield* Effect.promise(() => client.query(`LISTEN ${Pg.escapeIdentifier(channel)}`));
        const store = yield* EventStore;
        yield* store.append("Counter-notified", 0, [event(1)]);
        const signal = yield* Queue.take(signals).pipe(Effect.timeout("250 millis"));
        expect(signal.channel).toBe(channel);
        expect(signal.payload).toBe("committed");
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            for (const table of Object.values(tables))
              yield* sql`DROP TABLE IF EXISTS ${sql(table)}`;
            yield* sql`DROP FUNCTION IF EXISTS ${sql(notificationFunctionName(tables.events))}()`;
          }).pipe(Effect.orDie),
        ),
        Effect.provide(storesLayer({ tablePrefix }).pipe(Layer.provideMerge(migrated))),
        Effect.scoped,
      ),
    );
  });
});
