import * as SqlClient from "@effect/sql/SqlClient";
import type { SqlError } from "@effect/sql/SqlError";
import { Effect } from "effect";

/**
 * Application unit of work over one `SqlClient` transaction.
 *
 * Every write the effect performs through the ambient `SqlClient` —
 * aggregate appends (`EventStore.append`, `appendWithOutbox`), outbox
 * enqueue, inbox dedupe, idempotency claims, snapshot saves, and the
 * application's own SQL on the same client — joins ONE PostgreSQL
 * transaction: either all of it commits, or a failure or interruption
 * anywhere rolls the whole unit back. Optimistic concurrency and typed
 * conflicts (`ConcurrencyConflict`) are unchanged.
 *
 * Publishing stays out of the transaction by construction: the outbox
 * relay reads `pending` on its own connection, so a staged message becomes
 * visible to it only after the unit commits — a rolled-back unit never
 * publishes anything.
 *
 * Nesting: a `withUnitOfWork` started inside another one does NOT open a
 * second database transaction. It becomes a SAVEPOINT (`@effect/sql`
 * nests `withTransaction` automatically), so an inner unit that fails
 * rolls back only its own writes and the outer unit may catch the failure
 * and continue; an uncaught inner failure rolls back the outer unit too.
 * CQRS handlers wrapped this way compose without accidental commit points,
 * and `SqlError` remains the only error the unit itself can add.
 */
export const withUnitOfWork = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | SqlError, R | SqlClient.SqlClient> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(effect));
