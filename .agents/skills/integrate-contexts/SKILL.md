---
name: integrate-contexts
description: Integrate two bounded contexts in a @structure-based app via outbox, relay, and inbox - integration events, retries, dead letters, dedupe. Use when one context must react to another's facts.
---

# Integrate contexts

Cross-context effects never happen by writing another context's tables or loading its aggregates: the owning context emits integration events through its **outbox**, a relay publishes them, and the consuming context dedupes through its **inbox**. Exactly-once business effects come from expected-version appends plus inbox dedupe — not from any transport guarantee. Reference: `packages/eventsourcing/README.md`.

## Steps

1. **Define the integration event** in the emitting context — a past-tense fact about *its* domain (`InvoiceApproved`), registered in *its* `EventRegistry`. It references other aggregates by id only; it is not a shared "integration schema" module.

2. **Append events + outbox message atomically**:

```ts
// durable adapters: one transaction — a crash between "decided" and "notified" is impossible
yield* appendWithOutbox(streamName, expectedVersion, events, [
  { messageId, topic: "billing.invoice-approved", payload },
]);
// in-memory wiring: outbox.enqueue([{ messageId, topic, payload }])
```

3. **Run the relay** in a worker process: `OutboxRelay.run` polls pending → publishes → marks; exponential backoff with jitter; after `maxAttempts` (default 5) entries dead-letter and keep the last error. `OutboxRelay.drain` empties the queue once (tests, shutdown).
4. **Consume idempotently** — dedupe every side effect:

```ts
yield* Inbox.dedupe(consumerId, messageId)(
  dispatchFollowUpCommand, // or any Effect; marked processed only on success
);
```

   The effect runs only for unseen messages and is marked after success — a failure leaves it unmarked so redelivery retries.
5. **Prefer projections for read models** (no inbox needed — checkpoints already dedupe per batch; see create-event-handler). Reach for inbox + consumer when the reaction is a command dispatch or an external side effect.
6. **Monitor**: `Outbox.pending(limit)` for queue depth, `Outbox.deadLetters()` for diagnosis — relay health is an operational signal, surface it.
7. **Tests:** append + enqueue → `drain` → assert consumer saw the message exactly once; append the same messageId again → no double-apply. Follow `packages/eventsourcing/test/`.

## Rules

- Messages carry facts, not commands: the consumer decides what to do; the emitter doesn't order it around.
- Consumers are idempotent by contract — delivery is at-least-once everywhere.
- Each context consumes through its own inbox/consumer id; never share a dedupe key namespace across consumers.
- Dead letters are data with the last error attached — fix and replay deliberately; the relay never silently drops.
- Gate irreversible side effects on `ctx.live === true` (rebuild/replay must not re-send emails or payments).

## Verify

`bun x tsc --noEmit && bun test` in the package.
