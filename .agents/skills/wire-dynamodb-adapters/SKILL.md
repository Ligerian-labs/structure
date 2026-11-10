---
name: wire-dynamodb-adapters
description: Replace in-memory event-sourcing, view-model, or auth stores with DynamoDB adapters in a @structure-based app - single table, ULID feed, access patterns, DynamoDB Local. Use when the app must persist to DynamoDB.
---

# Wire DynamoDB adapters

Three packages share ONE DynamoDB table (ADR-0015): `@structure-ai/eventsourcing-dynamodb` (the five ports + `ensureTables`), `@structure-ai/viewmodel-dynamodb` (declared access patterns), `@structure-ai/auth-dynamodb` (AuthStore). Driver: `@effect-aws/dynamodb`.

## Steps

1. **The table** — one per environment (default `structure`), created idempotently by `ensureTables` (runs inside the eventsourcing `layer`): `feed`/`status` GSIs + `exp` TTL. No SQL migrations apply; evolving access patterns = adding GSIs (`ensureViewIndexes` does this for view models).

```ts
import { layer as DynamoLive } from "@structure-ai/eventsourcing-dynamodb";

const DynamoLive = DynamoLive.layer({
  tableName: settings.tableName,       // from @structure-ai/config
  region: settings.region,
  // endpoint/accessKeyId/secretAccessKey for local or static creds
});
// Provides EventStore | SnapshotStore | CheckpointStore | Outbox | Inbox.
```

2. **Consistency model** — per-stream order is exact (stream versions); `readAll` orders by ULID positions (monotonic, resumable, *approximately* global — clock skew). `readAll` and outbox `pending`/`deadLetters` read GSIs (eventually consistent): projections converge on poll cycles, never assert single-read freshness after a write.
3. **Transactional outbox** — appends that must publish use `appendWithOutbox(stream, expectedVersion, events, messages)`: one `TransactWriteItems` (≤99 items); a duplicate message id dies and nothing persists. For production relays prefer DynamoDB Streams over the poll-based outbox where the deployment allows.
4. **View models** — declare access patterns; undeclared queries fail loudly:

```ts
const store = yield* makeWithIndexes(OrderView, {
  tableName, patterns: { byTenant: { partition: ["tenantId"] } },
});
```

5. **Auth** — `makeAuthStore({ tableName })` over the same table; pass to `makeAuth`. Uniqueness conflicts (email, provider identity, passkey counter CAS) surface as `IdentityConflict`.
6. **Tests** — DynamoDB Local: `docker run -d -p 8000:8000 amazon/dynamodb-local`, then `DYNAMODB_ENDPOINT_URL=http://127.0.0.1:8000` with static creds (`local`/`local`, region `local`). Adapter suites skip without the env.

## Rules

- Never write outside the key conventions (prefixed `pk`/`sk`, `entity` discriminator); app-owned entities go in their own prefixed keys, never another port's.
- Do not chase strict global event order with a counter item without revisiting ADR-0015 (hot-partition cost).
- Secrets (access keys) come from config as `Redacted`; never log them.
- `DynamoDbError.classification` follows the repo taxonomy (throttling/internal → transient).

## Verify

`bun x tsc --noEmit && DYNAMODB_ENDPOINT_URL=http://127.0.0.1:8000 bun test` in the adapter package.
