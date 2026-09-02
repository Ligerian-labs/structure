import * as SqlClient from "@effect/sql/SqlClient";
import {
  BeginOutcome,
  type IdempotencyContext,
  IdempotencyStore,
  type IdempotencyStoreService,
} from "@structure-ai/cqrs";
import { Duration, Effect, Layer } from "effect";
import { jsonText } from "./internal.js";
import { type AdapterOptions, tableNames } from "./schema.js";

/** Options of the idempotency store (shared through `AdapterOptions`). */
export interface IdempotencyStoreOptions {
  /**
   * How long an idempotency record lives, measured from its last claim or
   * completion (default: 24 hours). An expired record is treated as absent
   * by `begin` — the key can be claimed and run again — and is removed by
   * `purgeExpiredIdempotency`. Choose it to cover the callers' retry
   * window; note an in-flight claim left by a crashed process blocks its
   * key until it expires.
   */
  readonly idempotencyTtl?: Duration.DurationInput;
}

const defaultTtl: Duration.DurationInput = "24 hours";

const ttlSeconds = (options?: IdempotencyStoreOptions): number =>
  Duration.toSeconds(options?.idempotencyTtl ?? defaultTtl);

/** Anonymous dispatches share one scope, stored as the empty actor. */
const actorColumn = (context: IdempotencyContext): string => context.actor ?? "";

interface IdempotencyRow {
  readonly status: string;
  readonly payload_hash: string;
  readonly result: string | null;
}

/**
 * `IdempotencyStore` persisting claims in `idempotency`, keyed by
 * `(tag, actor, key)`. `begin` is a single conditional upsert: it inserts
 * a fresh claim, replaces an expired record, or — when a live record
 * exists — reads it back to report `Completed`, `InFlight` or `Mismatch`.
 * Two concurrent `begin` calls therefore yield exactly one `Claimed`.
 * Records expire `idempotencyTtl` after their last claim or completion.
 */
export const idempotencyStoreLayer = (
  options?: AdapterOptions,
): Layer.Layer<IdempotencyStore, never, SqlClient.SqlClient> =>
  Layer.effect(
    IdempotencyStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const table = tableNames(options).idempotency;
      const ttl = ttlSeconds(options);

      const claim = (context: IdempotencyContext) =>
        sql<{ readonly status: string }>`
          INSERT INTO ${sql(table)} (tag, actor, key, payload_hash, status, result, created_at, expires_at)
          VALUES (${context.tag}, ${actorColumn(context)}, ${context.key}, ${context.payloadHash},
                  'claimed', NULL, now(), now() + make_interval(secs => ${ttl}))
          ON CONFLICT (tag, actor, key) DO UPDATE
            SET payload_hash = EXCLUDED.payload_hash,
                status = 'claimed',
                result = NULL,
                created_at = now(),
                expires_at = EXCLUDED.expires_at
            WHERE ${sql(table)}.expires_at <= now()
          RETURNING status
        `;

      const existing = (context: IdempotencyContext) =>
        sql<IdempotencyRow>`
          SELECT status, payload_hash, result::text AS result
          FROM ${sql(table)}
          WHERE tag = ${context.tag} AND actor = ${actorColumn(context)} AND key = ${context.key}
        `;

      const service: IdempotencyStoreService = {
        begin: (context) =>
          Effect.gen(function* () {
            const claimed = yield* claim(context);
            if (claimed.length > 0) return BeginOutcome.Claimed();
            const rows = yield* existing(context);
            const row = rows[0];
            // The live record vanished between the upsert and the read: its
            // owner released it. The caller retries and claims it fresh.
            if (row === undefined) return BeginOutcome.InFlight();
            if (row.payload_hash !== context.payloadHash) return BeginOutcome.Mismatch();
            if (row.status !== "completed") return BeginOutcome.InFlight();
            return BeginOutcome.Completed({
              result: row.result === null ? null : (JSON.parse(row.result) as unknown),
            });
          }).pipe(Effect.orDie),
        complete: (context, result) =>
          sql`
            UPDATE ${sql(table)}
            SET status = 'completed',
                result = ${jsonText(result)}::jsonb,
                expires_at = now() + make_interval(secs => ${ttl})
            WHERE tag = ${context.tag} AND actor = ${actorColumn(context)} AND key = ${context.key}
          `.pipe(Effect.orDie, Effect.asVoid),
        release: (context) =>
          sql`
            DELETE FROM ${sql(table)}
            WHERE tag = ${context.tag} AND actor = ${actorColumn(context)} AND key = ${context.key}
              AND status = 'claimed'
          `.pipe(Effect.orDie, Effect.asVoid),
      };
      return IdempotencyStore.of(service);
    }),
  );

/**
 * Deletes every idempotency record past its `expires_at` and returns how
 * many were removed. `begin` already ignores expired records, so this only
 * bounds table growth: run it periodically (a job, a cron'd CLI command)
 * from any instance — it is safe to run concurrently.
 */
export const purgeExpiredIdempotency = (
  options?: AdapterOptions,
): Effect.Effect<number, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const table = tableNames(options).idempotency;
    const removed = yield* sql<{ readonly key: string }>`
      DELETE FROM ${sql(table)}
      WHERE expires_at <= now()
      RETURNING key
    `;
    return removed.length;
  }).pipe(Effect.orDie);
