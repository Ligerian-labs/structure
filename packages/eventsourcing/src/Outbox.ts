import { Clock, Context, Duration, Effect, Either, Option, Random, Ref } from "effect";

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
 * Transactional outbox port. Adapters call `enqueue` in the same
 * transaction as the event append so a message is staged iff the events
 * committed; the relay then delivers staged messages at-least-once.
 *
 * Scheduling is durable: `pending` only returns entries whose
 * `availableAt` has elapsed, and the relay persists the next eligible
 * time on every failed attempt, so delayed delivery and retry backoff
 * survive process restarts.
 */
export interface OutboxService {
  /**
   * Stages messages for publication. Idempotent per `message.id`: a message
   * whose id is already known is ignored, so redelivered enqueues are safe.
   */
  readonly enqueue: (messages: ReadonlyArray<OutboxMessage>) => Effect.Effect<void>;
  /**
   * Up to `limit` pending entries that are due now, in stable enqueue
   * order. Entries scheduled for the future (initially, or while backing
   * off after a failed attempt) are not returned until their time comes.
   */
  readonly pending: (limit: number) => Effect.Effect<ReadonlyArray<OutboxEntry>>;
  /** Marks entries as successfully published. */
  readonly markPublished: (ids: ReadonlyArray<string>) => Effect.Effect<void>;
  /**
   * Records a failed attempt: the entry stays pending with
   * `attempts`/`error` updated and becomes eligible again at `retryAt`
   * (epoch milliseconds; absent means immediately). Persisting the
   * schedule here is what makes relay backoff restart-safe.
   */
  readonly markFailed: (
    id: string,
    error: string,
    attempts: number,
    retryAt?: number,
  ) => Effect.Effect<void>;
  /** Moves an entry to the dead letters, keeping the final error text. */
  readonly markDead: (id: string, error: string) => Effect.Effect<void>;
  /**
   * Requeues dead-lettered entries: back to pending with the attempt
   * count, last error, and any delivery schedule cleared, so the next
   * relay pass delivers them fresh. Unknown or non-dead ids are ignored.
   */
  readonly replay: (ids: ReadonlyArray<string>) => Effect.Effect<void>;
  /** Entries given up on, with their last error and attempt count for diagnosis. */
  readonly deadLetters: () => Effect.Effect<ReadonlyArray<OutboxEntry>>;
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
   * `Schedule.jittered`. 0 disables jitter (deterministic tests).
   */
  readonly backoffJitter?: number;
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

const publishEntry = <EP, RP>(
  outbox: OutboxService,
  entry: OutboxEntry,
  options: OutboxRelayOptions<EP, RP>,
): Effect.Effect<void, never, RP> =>
  Effect.gen(function* () {
    const maxAttempts = options.maxAttempts ?? 5;
    if (entry.attempts >= maxAttempts) {
      return yield* outbox.markDead(
        entry.message.id,
        entry.lastError ?? "exhausted attempts before this pass",
      );
    }
    let attempts = entry.attempts;
    let lastError = entry.lastError ?? "unknown error";
    while (true) {
      const outcome = yield* Effect.either(options.publish(entry));
      if (Either.isRight(outcome)) {
        return yield* outbox.markPublished([entry.message.id]);
      }
      const text = describeError(outcome.left);
      attempts += 1;
      lastError = text;
      // Record every attempt (the dead letter keeps the final count for
      // diagnosis), then give up once the budget is spent.
      if (attempts >= maxAttempts) {
        yield* outbox.markFailed(entry.message.id, text, attempts);
        return yield* outbox.markDead(entry.message.id, lastError);
      }
      // Persist the schedule before sleeping: a crash mid-backoff must not
      // make the entry immediately eligible again on restart.
      const delayMillis = yield* backoffDelay(attempts, options);
      const retryAt = (yield* Clock.currentTimeMillis) + delayMillis;
      yield* outbox.markFailed(entry.message.id, text, attempts, retryAt);
      yield* Effect.sleep(delayMillis);
    }
  });

/**
 * Delivers every currently pending entry, then returns: polls `pending`,
 * publishes each entry with bounded retries (exponential backoff with
 * jitter), and loops until nothing is pending — every entry ends either
 * published or dead-lettered with its last error. Intended for tests and
 * one-shot flushing.
 */
export const drain = <EP, RP>(
  options: OutboxRelayOptions<EP, RP>,
): Effect.Effect<void, never, Outbox | RP> =>
  Effect.gen(function* () {
    const outbox = yield* Outbox;
    while (true) {
      const entries = yield* outbox.pending(options.batchSize ?? 32);
      if (entries.length === 0) {
        return;
      }
      for (const entry of entries) {
        yield* publishEntry(outbox, entry, options);
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
): Effect.Effect<never, never, Outbox | RP> =>
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
  readonly seen: (consumerId: string, messageId: string) => Effect.Effect<boolean>;
  /** Records `messageId` as processed by `consumerId`. */
  readonly markProcessed: (consumerId: string, messageId: string) => Effect.Effect<void>;
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
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<Option.Option<A>, E, R | Inbox> =>
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
