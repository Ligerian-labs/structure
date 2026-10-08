import { PgClient } from "@effect/sql-pg";
import { PersistenceError } from "@structure-ai/domain";
import { EventBus } from "@structure-ai/eventsourcing";
import { Deferred, Duration, Effect, Layer, PubSub, Queue, Redacted } from "effect";
import * as Pg from "pg";
import { notificationTriggerName } from "./notifications.js";
import { type AdapterOptions, tableNames } from "./schema.js";

/**
 * One dedicated LISTEN connection per bus. Layer acquisition completes LISTEN
 * before returning; projections then subscribe locally before reading history.
 * A connection failure stops current and future waiters with PersistenceError.
 * Supervise/restart workers to reconnect and recover from their checkpoints.
 */
export const eventBusLayer = (
  options?: AdapterOptions,
): Layer.Layer<EventBus, PersistenceError, PgClient.PgClient> =>
  Layer.scoped(
    EventBus,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const rows = yield* sql<{ readonly channel: string | null; readonly enabled: boolean }>`
      SELECT 'structure_events_' || to_regclass(quote_ident(${tableNames(options).events}))::oid::text AS channel,
        EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgrelid = to_regclass(quote_ident(${tableNames(options).events}))
            AND tgname = ${notificationTriggerName} AND tgenabled IN ('O', 'A')
        ) AS enabled
    `.pipe(
        Effect.mapError((cause) => new PersistenceError({ operation: "EventBus.channel", cause })),
      );
      const channel = rows[0]?.channel;
      if (channel === undefined || channel === null || rows[0]?.enabled !== true) {
        return yield* new PersistenceError({
          operation: "EventBus.channel",
          cause: new Error(
            "Apply eventsourcing-pg schema revision 5 before starting the event bus",
          ),
        });
      }
      const hub = yield* Effect.acquireRelease(PubSub.sliding<void>(1), PubSub.shutdown);
      const failed = yield* Deferred.make<never, PersistenceError>();
      const config = sql.config;
      const client = new Pg.Client({
        connectionString: config.url === undefined ? undefined : Redacted.value(config.url),
        host: config.host,
        port: config.port,
        user: config.username,
        password: config.password === undefined ? undefined : Redacted.value(config.password),
        database: config.database,
        ssl: config.ssl,
        types: config.types,
        ...(config.stream === undefined ? {} : { stream: config.stream }),
        connectionTimeoutMillis: Duration.toMillis(config.connectTimeout ?? "5 seconds"),
        application_name: `${config.applicationName ?? "@structure-ai/eventsourcing-pg"}/events`,
        keepAlive: true,
        keepAliveInitialDelayMillis: 10000,
      });
      const onFailure = (cause: unknown) =>
        Deferred.unsafeDone(
          failed,
          Effect.fail(new PersistenceError({ operation: "EventBus.listen", cause })),
        );
      const onEnd = () => onFailure(new Error("PostgreSQL notification connection closed"));
      const onNotification = (notification: Pg.Notification) => {
        if (notification.channel === channel) hub.unsafeOffer(undefined);
      };
      client.on("error", onFailure);
      client.on("end", onEnd);
      client.on("notification", onNotification);
      yield* Effect.acquireRelease(Effect.succeed(client), () => {
        client.off("notification", onNotification);
        client.off("end", onEnd);
        client.off("error", onFailure);
        client.on("error", () => {});
        return Effect.promise(() => client.end()).pipe(
          Effect.timeoutOption("1 second"),
          Effect.asVoid,
        );
      });
      yield* Effect.tryPromise({
        try: () => client.connect(),
        catch: (cause) => new PersistenceError({ operation: "EventBus.connect", cause }),
      });
      yield* Effect.tryPromise({
        try: () => client.query(`LISTEN ${Pg.escapeIdentifier(channel)}`),
        catch: (cause) => new PersistenceError({ operation: "EventBus.listen", cause }),
      }).pipe(
        Effect.timeoutFail({
          duration: config.connectTimeout ?? "5 seconds",
          onTimeout: () =>
            new PersistenceError({
              operation: "EventBus.listen",
              cause: new Error("LISTEN timed out"),
            }),
        }),
      );
      return EventBus.of({
        notify: sql`SELECT pg_notify(${channel}, 'committed')`.pipe(
          Effect.mapError((cause) => new PersistenceError({ operation: "EventBus.notify", cause })),
          Effect.asVoid,
        ),
        subscribe: PubSub.subscribe(hub).pipe(
          Effect.map((queue) => Effect.raceFirst(Deferred.await(failed), Queue.take(queue))),
        ),
      });
    }),
  );
