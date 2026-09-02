import * as SqlClient from "@effect/sql/SqlClient";
import type { SqlError } from "@effect/sql/SqlError";
import { Effect } from "effect";
import { NisshiClient } from "./protocol/client.js";
import type { NisshiApiError, NisshiConnectionError } from "./protocol/errors.js";
import { type SidecarOptions, sidecarTables } from "./sidecar.js";

export interface RelayOptions extends SidecarOptions {
  /** Entries fetched per poll (default 32). */
  readonly batchSize?: number;
}

interface PendingRow {
  readonly stream_name: string;
  readonly version: number | bigint | string;
  readonly topic: string;
  readonly record_value: string;
}

/**
 * Produces every pending row whose append crashed between reservation and
 * confirmation, then removes it. There are no dead letters here: pending
 * rows are domain facts that already passed the ledger — the relay retries
 * until the topic accepts them. A crash after produce but before delete
 * re-produces a duplicate; readers dedupe by `(stream, version)`.
 */
export const drainPending = (
  options?: RelayOptions,
): Effect.Effect<
  void,
  NisshiApiError | NisshiConnectionError | SqlError,
  SqlClient.SqlClient | NisshiClient
> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const client = yield* NisshiClient;
    const tables = sidecarTables(options);

    for (;;) {
      const rows = yield* sql<PendingRow>`
        SELECT stream_name, version, topic, record_value
        FROM ${sql(tables.pending)}
        ORDER BY stream_name, version
        LIMIT ${options?.batchSize ?? 32}
      `;
      if (rows.length === 0) {
        return;
      }
      for (const row of rows) {
        yield* client.produce(row.topic, [
          {
            key: new TextEncoder().encode(row.stream_name),
            value: new TextEncoder().encode(row.record_value),
          },
        ]);
        yield* Effect.asVoid(sql`
          DELETE FROM ${sql(tables.pending)}
          WHERE stream_name = ${row.stream_name} AND version = ${row.version}
        `);
      }
    }
  });

/** Runs `drainPending` forever, sleeping `pollInterval` between passes. */
export const runPendingRelay = (
  options?: RelayOptions & { readonly pollInterval?: number },
): Effect.Effect<never, never, SqlClient.SqlClient | NisshiClient> =>
  Effect.gen(function* () {
    const interval = options?.pollInterval ?? 500;
    for (;;) {
      yield* drainPending(options).pipe(
        Effect.ignore,
        Effect.catchAllDefect(() => Effect.void),
      );
      yield* Effect.sleep(interval);
    }
  });
