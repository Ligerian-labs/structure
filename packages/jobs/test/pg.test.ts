import { describe, expect, test } from "bun:test";
import * as SqlClient from "@effect/sql/SqlClient";
import { PgClient } from "@effect/sql-pg";
import { Readiness, Shutdown } from "@structure-ai/runtime";
import {
  Context,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Redacted,
  Schema as S,
  Scope,
} from "effect";
import { migrate, Scheduler, schedulerLayer, tableNames } from "../src/index.js";
import { registerSchedulerScenarios, type SchedulerHarness } from "./scenarios.js";

const databaseUrl = process.env.DATABASE_URL;
const gated = databaseUrl === undefined ? describe.skip : describe;

gated("PostgreSQL scheduler (needs DATABASE_URL)", () => {
  registerSchedulerScenarios(async (harnessOptions) => {
    const tablePrefix = `t${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}_`;
    const clock = { value: new Date("2026-08-20T12:00:00.000Z") };
    const tables = tableNames({ tablePrefix });

    const scope = Effect.runSync(Scope.make());
    const SchedulerLive = schedulerLayer({
      tablePrefix,
      now: () => clock.value,
      random: () => 0.5,
    }).pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(databaseUrl as string) })));

    const context = await Effect.runPromise(Layer.buildWithScope(SchedulerLive, scope));
    const sql = Context.get(context, SqlClient.SqlClient);
    await Effect.runPromise(
      migrate({ tablePrefix }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
    );

    const shutdownContext = await Effect.runPromise(
      Layer.buildWithScope(
        Shutdown.layer({
          finalizerTimeout: Duration.millis(harnessOptions?.finalizerTimeoutMillis ?? 10_000),
        }).pipe(Layer.provide(Readiness.layer)),
        scope,
      ),
    );
    const shutdown = Context.get(shutdownContext, Shutdown);
    const scheduler = Context.get(context, Scheduler);
    const logRecords: Array<{ message: string; annotations: Record<string, unknown> }> = [];
    const recordingLogger = Logger.replace(
      Logger.defaultLogger,
      Logger.make(({ message, annotations }) => {
        logRecords.push({
          message: Array.isArray(message) ? String(message[0]) : String(message),
          annotations: Object.fromEntries(annotations),
        });
      }),
    );

    const harness: SchedulerHarness = {
      scheduler,
      clock,
      startWorker: (options): Promise<Fiber.RuntimeFiber<void, never>> =>
        Effect.runPromise(
          Effect.forkDaemon(
            scheduler
              .runWorker({
                ...(options?.batchSize === undefined ? {} : { batchSize: options.batchSize }),
                ...(options?.concurrency === undefined ? {} : { concurrency: options.concurrency }),
                ...(options?.pollMillis === undefined
                  ? {}
                  : { pollInterval: Duration.millis(options.pollMillis) }),
                ...(options?.leaseMillis === undefined
                  ? {}
                  : { lease: Duration.millis(options.leaseMillis) }),
                ...(options?.drainTimeoutMillis === undefined
                  ? {}
                  : { drainTimeout: Duration.millis(options.drainTimeoutMillis) }),
              })
              .pipe(Effect.provideService(Shutdown, shutdown), Effect.provide(recordingLogger)),
          ),
        ),
      logRecords: () => logRecords,
      stopWorker: () =>
        Effect.runPromise(shutdown.trigger("test-complete").pipe(Effect.provide(recordingLogger))),
      deadLetters: () =>
        Effect.runPromise(
          sql`SELECT job_name, attempts FROM ${sql(tables.deadLetters)} ORDER BY dead_at`,
        ),
      queueRows: () =>
        Effect.runPromise(
          sql<{
            id: string;
            status: string;
            attempt: number;
            lease_owner: string | null;
            lease_expires_at: Date | null;
          }>`SELECT id, status, attempt, lease_owner, lease_expires_at FROM ${sql(tables.queue)}`,
        ),
      reclaim: (jobId, owner, leaseMillis) =>
        Effect.runPromise(
          sql`
            UPDATE ${sql(tables.queue)}
            SET status = 'running', attempt = attempt + 1, lease_owner = ${owner},
                lease_expires_at = ${new Date(Date.now() + leaseMillis).toISOString()}
            WHERE id = ${jobId}
          `.pipe(Effect.asVoid),
        ),
      close: async () => {
        await Effect.runPromise(Effect.orDie(sql`DROP TABLE IF EXISTS ${sql(tables.queue)}`));
        await Effect.runPromise(Effect.orDie(sql`DROP TABLE IF EXISTS ${sql(tables.deadLetters)}`));
        await Effect.runPromise(Scope.close(scope, Exit.void));
      },
    };
    return harness;
  });
});

gated("migrate on a table created before the lease fence (needs DATABASE_URL)", () => {
  test("adds lease_owner to an existing queue table, keeps its rows, and stays idempotent", async () => {
    const tablePrefix = `l${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}_`;
    const tables = tableNames({ tablePrefix });
    const scope = Effect.runSync(Scope.make());
    const context = await Effect.runPromise(
      Layer.buildWithScope(PgClient.layer({ url: Redacted.make(databaseUrl as string) }), scope),
    );
    const sql = Context.get(context, SqlClient.SqlClient);
    const migrateHere = migrate({ tablePrefix }).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    try {
      // The queue table exactly as release 0.0.13 created it: no lease_owner.
      await Effect.runPromise(
        sql`
          CREATE TABLE ${sql(tables.queue)} (
            id TEXT PRIMARY KEY,
            job_name TEXT NOT NULL,
            payload TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('queued', 'running')),
            run_at TIMESTAMPTZ NOT NULL,
            cron_expr TEXT,
            cron_timezone TEXT,
            attempt INTEGER NOT NULL DEFAULT 0,
            max_attempts INTEGER NOT NULL DEFAULT 5,
            lease_expires_at TIMESTAMPTZ,
            last_error TEXT,
            correlation_id TEXT,
            causation_id TEXT,
            created_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL
          )
        `.pipe(Effect.asVoid),
      );
      await Effect.runPromise(
        sql`
          INSERT INTO ${sql(tables.queue)} (id, job_name, payload, status, run_at, created_at, updated_at)
          VALUES ('legacy-1', 'test.ping', '{}', 'queued', now(), now(), now())
        `.pipe(Effect.asVoid),
      );
      await Effect.runPromise(migrateHere);
      const columns = await Effect.runPromise(
        sql<{ column_name: string }>`
          SELECT column_name FROM information_schema.columns
          WHERE table_name = ${tables.queue} AND column_name = 'lease_owner'
        `,
      );
      expect(columns).toHaveLength(1);
      const rows = await Effect.runPromise(
        sql<{ id: string; lease_owner: string | null }>`
          SELECT id, lease_owner FROM ${sql(tables.queue)}
        `,
      );
      expect(rows).toEqual([{ id: "legacy-1", lease_owner: null }]);
      await Effect.runPromise(migrateHere);
    } finally {
      await Effect.runPromise(Effect.orDie(sql`DROP TABLE IF EXISTS ${sql(tables.queue)}`));
      await Effect.runPromise(Effect.orDie(sql`DROP TABLE IF EXISTS ${sql(tables.deadLetters)}`));
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  });
});

gated("dead-letter atomicity (needs DATABASE_URL)", () => {
  test("a dead-letter insert that fails rolls the fenced delete back: the queue row survives", async () => {
    const tablePrefix = `a${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}_`;
    const tables = tableNames({ tablePrefix });
    const scope = Effect.runSync(Scope.make());
    const layers = schedulerLayer({ tablePrefix }).pipe(
      Layer.provideMerge(PgClient.layer({ url: Redacted.make(databaseUrl as string) })),
      Layer.merge(
        Shutdown.layer({ finalizerTimeout: Duration.seconds(2) }).pipe(
          Layer.provide(Readiness.layer),
        ),
      ),
    );
    const context = await Effect.runPromise(Layer.buildWithScope(layers, scope));
    const sql = Context.get(context, SqlClient.SqlClient);
    const scheduler = Context.get(context, Scheduler);
    const shutdown = Context.get(context, Shutdown);
    try {
      await Effect.runPromise(
        migrate({ tablePrefix }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      );
      // Poison the dead-letter table: every insert into it now fails.
      await Effect.runPromise(
        sql`ALTER TABLE ${sql(tables.deadLetters)} ADD COLUMN poison TEXT NOT NULL`.pipe(
          Effect.asVoid,
        ),
      );
      await Effect.runPromise(
        scheduler.register({
          name: "test.ping",
          payloadSchema: S.parseJson(S.Struct({ message: S.String })),
          handle: () => Effect.fail({ reason: "bad-input", classification: "permanent" }),
        }),
      );
      const jobId = await Effect.runPromise(
        scheduler.schedule(
          { name: "test.ping", payloadSchema: S.parseJson(S.Struct({ message: S.String })) },
          { message: "doomed" },
        ),
      );
      const worker = await Effect.runPromise(
        Effect.forkDaemon(
          scheduler
            .runWorker({ pollInterval: Duration.millis(10), drainTimeout: Duration.millis(300) })
            .pipe(
              Effect.provideService(Shutdown, shutdown),
              Effect.catchAllCause(() => Effect.void),
            ),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      const rows = await Effect.runPromise(
        sql<{ id: string; status: string }>`SELECT id, status FROM ${sql(tables.queue)}`,
      );
      expect(rows.map((row) => row.id)).toEqual([jobId]);
      const dead = await Effect.runPromise(
        sql<{ id: string }>`SELECT id FROM ${sql(tables.deadLetters)}`,
      );
      expect(dead).toEqual([]);
      await Effect.runPromise(shutdown.trigger("test-complete"));
      await Effect.runPromise(Fiber.await(worker));
    } finally {
      await Effect.runPromise(Effect.orDie(sql`DROP TABLE IF EXISTS ${sql(tables.queue)}`));
      await Effect.runPromise(Effect.orDie(sql`DROP TABLE IF EXISTS ${sql(tables.deadLetters)}`));
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  });
});
