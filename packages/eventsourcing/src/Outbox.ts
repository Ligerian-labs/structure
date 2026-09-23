import type { PersistenceError } from "@structure-ai/domain";
import { Cause, Clock, Context, Duration, Effect, Exit, Option, Random } from "effect";

/**
 * A message staged for publication. `id` must be globally unique — it is
 * the deduplication key for consumers and the idempotence key for
 * `enqueue`. `availableAt` (epoch milliseconds) optionally schedules the
 * first delivery attempt: the message stays staged, invisible to
 * `pending`, until that time.
 */
export interface OutboxMessage {
  readonly id: string;
  readonly topic: string;
  readonly payload: unknown;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly availableAt?: number;
}

export type OutboxStatus = "pending" | "published" | "dead";

/** A staged message with its delivery bookkeeping. */
export interface OutboxEntry {
  readonly message: OutboxMessage;
  readonly status: OutboxStatus;
  /** Publish attempts made so far. */
  readonly attempts: number;
  /** Text of the most recent publish failure, if any. */
  readonly lastError?: string;
  /**
   * Epoch milliseconds before which no delivery attempt should be made
   * (from `OutboxMessage.availableAt` or the retry schedule persisted by
   * the relay through `markFailed`). Absent means immediately due.
   */
  readonly availableAt?: number;
}

/**
 * A batch of pending entries atomically claimed for delivery, plus the
 * claim token that settles them. The token is the relay's private lease
 * identity: it must never be logged or attached to error context.
 */
export interface OutboxClaim {
  /** The claimed entries, in stable enqueue order. */
  readonly entries: ReadonlyArray<OutboxEntry>;
  /** Opaque token required by `markPublished`/`markFailed`/`markDead` to settle. */
  readonly token: string;
  /**
   * Epoch milliseconds until which the claim is valid. Settlement with
   * this claim's token after that instant is rejected (fenced out).
   */
  readonly leaseUntil: number;
}

/**
 * Transactional outbox port. Adapters call `enqueue` in the same
 * transaction as the event append so a message is staged iff the events
 * committed; the relay then delivers staged messages at-least-once.
 *
 * Scheduling is durable: `pending` only returns entries whose
 * `availableAt` has elapsed, and the relay persists the next eligible
 * time on every failed attempt, so delayed delivery and retry backoff
 * survive process restarts.
 *
 * Delivery ownership is claim-based: `claim` atomically takes a lease on
 * up to `limit` due entries so concurrent relays never deliver the same
 * entry twice within a lease; `markPublished`/`markFailed`/`markDead`
 * require the claim's token, which fences out settlements from crashed
 * or slow workers whose lease expired and was recovered elsewhere.
 */
export interface OutboxService {
  /**
   * Stages messages for publication. Idempotent per `message.id`: a message
   * whose id is already known is ignored, so redelivered enqueues are safe.
   */
  readonly enqueue: (
    messages: ReadonlyArray<OutboxMessage>,
  ) => Effect.Effect<void, PersistenceError>;
  /**
   * Up to `limit` pending entries that are due now, in stable enqueue
   * order. Entries scheduled for the future (initially, or while backing
   * off after a failed attempt) are not returned until their time comes.
   */
  readonly pending: (limit: number) => Effect.Effect<ReadonlyArray<OutboxEntry>, PersistenceError>;
  /**
   * Atomically claims up to `limit` pending entries that are due now,
   * taking a lease of `lease` (a `DurationInput`) on each: other relays'
   * `pending`/`claim` cannot see the claimed entries until the lease
   * lapses or the claim settles. Claimed entries whose lease has expired
   * (a crashed or stalled worker) are eligible again, so at-least-once
   * delivery survives worker crashes.
   */
  readonly claim: (
    limit: number,
    lease: Duration.DurationInput,
  ) => Effect.Effect<OutboxClaim, PersistenceError>;
  /**
   * Marks entries as successfully published. Returns whether every entry
   * was applied: with a `claim` token, entries settled under a foreign or
   * expired claim are fenced out (false) — the caller's lease was lost.
   * Without a token, any pending entry is settled (single-writer mode).
   */
  readonly markPublished: (
    ids: ReadonlyArray<string>,
    claim?: string,
  ) => Effect.Effect<boolean, PersistenceError>;
  /**
   * Records a failed attempt: the entry stays pending with
   * `attempts`/`error` updated and becomes eligible again at `retryAt`
   * (epoch milliseconds; absent means immediately). Persisting the
   * schedule here is what makes relay backoff restart-safe. The claim
   * token, when given, must match the entry's live claim — a lost lease
   * returns false and changes nothing. A failed attempt does NOT release
   * the claim: the owning relay keeps retrying under its lease (broker
   * visibility semantics), and the entry becomes visible to other relays
   * only once that lease lapses.
   */
  readonly markFailed: (
    id: string,
    error: string,
    attempts: number,
    retryAt?: number,
    claim?: string,
  ) => Effect.Effect<boolean, PersistenceError>;
  /**
   * Moves an entry to the dead letters, keeping the final error text.
   * Fenced by the claim token like the other settlements; returns whether
   * it was applied.
   */
  readonly markDead: (
    id: string,
    error: string,
    claim?: string,
  ) => Effect.Effect<boolean, PersistenceError>;
  /**
   * Requeues dead-lettered entries: back to pending with the attempt
   * count, last error, and any delivery schedule cleared, so the next
   * relay pass delivers them fresh. Unknown or non-dead ids are ignored.
   */
  readonly replay: (ids: ReadonlyArray<string>) => Effect.Effect<void, PersistenceError>;
  /** Entries given up on, with their last error and attempt count for diagnosis. */
  readonly deadLetters: () => Effect.Effect<ReadonlyArray<OutboxEntry>, PersistenceError>;
}

/** Service tag for the outbox port. */
export class Outbox extends Context.Tag("@structure-ai/eventsourcing/Outbox")<
  Outbox,
  OutboxService
>() {}

/** Renders an unknown publish error as text for dead-letter context. */
const describeError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null) {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
};

export interface OutboxRelayOptions<EP, RP> {
  /** Publishes one staged entry to the transport. Any failure is retryable. */
  readonly publish: (entry: OutboxEntry) => Effect.Effect<void, EP, RP>;
  /** Delay between polls when nothing is pending (only `run`). Default 500 millis. */
  readonly pollInterval?: Duration.DurationInput;
  /** Total publish attempts per message before dead-lettering. Default 5. */
  readonly maxAttempts?: number;
  /** Base delay of the exponential backoff between attempts. Default 100 millis. */
  readonly backoffBase?: Duration.DurationInput;
  /** Max entries fetched per poll. Default 32. */
  readonly batchSize?: number;
  /**
   * Jitter spread of the retry backoff, as a fraction of the computed
   * delay (0.2 keeps the delay within ±20%). Default 0.2, matching
   * `Schedule.jittered`. 0 disables jitter (deterministic).
   */
  readonly backoffJitter?: number;
  /**
   * Lease taken on each claim, bounding how long a crashed or stalled
   * relay can hold entries before another relay recovers them. Default 30
   * seconds. Publishing must finish well within it, and every settlement
   * carries the claim token — a settlement arriving after the lease
   * lapsed and was recovered elsewhere is fenced out.
   */
  readonly lease?: Duration.DurationInput;
}

/**
 * One backoff delay for the given 1-based attempt count, as
 * `backoffBase * 2^(attempt-1) * (1 ± spread)`, clamped to a 24-hour
 * ceiling. With `backoffJitter: 0` the delay is deterministic.
 */
const backoffDelay = (
  attempt: number,
  options: OutboxRelayOptions<unknown, unknown>,
): Effect.Effect<number> => {
  const base = Duration.toMillis(options.backoffBase ?? "100 millis");
  const spread = options.backoffJitter === undefined ? 0.2 : Math.max(0, options.backoffJitter);
  const bounded = Math.min(base * 2 ** (attempt - 1), Duration.toMillis("24 hours"));
  if (spread === 0) {
    return Effect.succeed(bounded);
  }
  return Random.nextRange(1 - spread, 1 + spread).pipe(Effect.map((factor) => bounded * factor));
};

/**
 * Publishes one claimed entry. Settlements are fenced by the claim token:
 * when the lease lapses mid-retry and another relay recovers the entry,
 * the original relay stops retrying and leaves the entry to its new
 * owner. Returns whether this relay still owned the entry at the end
 * (published, dead-lettered, or released for its retried schedule);
 * false means ownership was lost and the caller must not touch it again.
 */
const publishEntry = <EP, RP>(
  outbox: OutboxService,
  entry: OutboxEntry,
  token: string,
  options: OutboxRelayOptions<EP, RP>,
): Effect.Effect<boolean, PersistenceError | EP, RP> =>
  Effect.gen(function* () {
    const maxAttempts = options.maxAttempts ?? 5;
    if (entry.attempts >= maxAttempts) {
      // Dead-lettering the pre-exhausted entry: fenced out iff the lease
      // was already recovered elsewhere (false — nothing was written).
      return yield* outbox.markDead(
        entry.message.id,
        entry.lastError ?? "exhausted attempts before this pass",
        token,
      );
    }
    let attempts = entry.attempts;
    let lastError = entry.lastError ?? "unknown error";
    while (true) {
      const outcome = yield* Effect.exit(options.publish(entry));
      if (Exit.isSuccess(outcome)) {
        // Published on the broker. A false settlement means another relay
        // recovered the expired lease meanwhile and owns the record; this
        // relay is done with the entry either way.
        return yield* outbox.markPublished([entry.message.id], token);
      }
      if (!Cause.isFailType(outcome.cause)) return yield* Effect.failCause(outcome.cause);
      const text = describeError(outcome.cause.error);
      attempts += 1;
      lastError = text;
      // Record every attempt (the dead letter keeps the final count for
      // diagnosis), then give up once the budget is spent.
      if (attempts >= maxAttempts) {
        yield* outbox.markFailed(entry.message.id, text, attempts, undefined, token);
        return yield* outbox.markDead(entry.message.id, lastError, token);
      }
      // Persist the schedule before sleeping: a crash mid-backoff must not
      // make the entry immediately eligible again on restart. Settlement
      // fails when this relay lost the lease while publishing — the entry
      // belongs to whoever recovered it.
      const delayMillis = yield* backoffDelay(attempts, options);
      const retryAt = (yield* Clock.currentTimeMillis) + delayMillis;
      const held = yield* outbox.markFailed(entry.message.id, text, attempts, retryAt, token);
      if (!held) {
        return false;
      }
      yield* Effect.sleep(delayMillis);
    }
  });

/**
 * Delivers every currently pending entry, then returns: claims batches of
 * due entries, publishes each with bounded retries (exponential backoff
 * with jitter), and loops until nothing is claimable — every entry ends
 * either published or dead-lettered with its last error, and concurrent
 * drains deliver each message at most once per lease. Intended for tests
 * and one-shot flushing.
 */
export const drain = <EP, RP>(
  options: OutboxRelayOptions<EP, RP>,
): Effect.Effect<void, PersistenceError | EP, Outbox | RP> =>
  Effect.gen(function* () {
    const outbox = yield* Outbox;
    while (true) {
      const { entries, token } = yield* outbox.claim(
        options.batchSize ?? 32,
        options.lease ?? "30 seconds",
      );
      if (entries.length === 0) {
        return;
      }
      for (const entry of entries) {
        yield* publishEntry(outbox, entry, token, options);
      }
    }
  });

/**
 * Runs the relay forever: drain all pending entries, sleep `pollInterval`,
 * repeat. Delivery is at-least-once — a crash between a successful publish
 * and `markPublished` republishes the entry, so consumers must deduplicate
 * by message id (see `Inbox`). Per-message publish order follows enqueue
 * order, but retries of one message do not block later messages forever:
 * after `maxAttempts` failed attempts the message is dead-lettered.
 */
export const run = <EP, RP>(
  options: OutboxRelayOptions<EP, RP>,
): Effect.Effect<never, PersistenceError | EP, Outbox | RP> =>
  drain(options).pipe(
    Effect.andThen(Effect.sleep(options.pollInterval ?? "500 millis")),
    Effect.forever,
  );

/** Polling relay that moves outbox entries to the transport. See `run` and `drain`. */
export const OutboxRelay = { run, drain } as const;

/**
 * Idempotent-consumer port: remembers which message ids a consumer has
 * fully processed, so at-least-once delivery becomes effectively-once
 * processing.
 */
export interface InboxService {
  /** Whether `messageId` was already processed by `consumerId`. */
  readonly seen: (
    consumerId: string,
    messageId: string,
  ) => Effect.Effect<boolean, PersistenceError>;
  /** Records `messageId` as processed by `consumerId`. */
  readonly markProcessed: (
    consumerId: string,
    messageId: string,
  ) => Effect.Effect<void, PersistenceError>;
}

/** Service tag for the inbox port. */
export class Inbox extends Context.Tag("@structure-ai/eventsourcing/Inbox")<Inbox, InboxService>() {
  /**
   * Runs `effect` only if `messageId` is new for `consumerId`, marking it
   * processed after success. Returns `Option.none` when the message was a
   * duplicate and the effect was skipped. A failure of `effect` leaves the
   * message unmarked, so a redelivery retries it.
   */
  static readonly dedupe =
    (consumerId: string, messageId: string) =>
    <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<Option.Option<A>, E | PersistenceError, R | Inbox> =>
      Effect.gen(function* () {
        const inbox = yield* Inbox;
        if (yield* inbox.seen(consumerId, messageId)) {
          return Option.none<A>();
        }
        const result = yield* effect;
        yield* inbox.markProcessed(consumerId, messageId);
        return Option.some(result);
      });
}
