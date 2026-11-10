# @structure-ai/eventsourcing-dynamodb

Durable event-sourcing adapters for the same five ports over Amazon DynamoDB: single-table layout, ULID global feed, transactional append + outbox (ADR-0015).

## Usage

```ts
import { layer } from "@structure-ai/eventsourcing-dynamodb";

const DynamoLive = layer({
  tableName: "structure",       // the shared single table
  region: "eu-west-1",
  // endpoint: "http://127.0.0.1:8000",  // DynamoDB Local
  // accessKeyId / secretAccessKey for local/static creds (Redacted)
});
// provides EventStore | SnapshotStore | CheckpointStore | Outbox | Inbox
// (+ the @effect-aws/dynamodb document client), ensureTables runs at build.
```

- **Positions are ULIDs mapped to `bigint`**: per-stream order is exact (versions); the global feed (`readAll`) is ordered by ULID — monotonic and resumable, *approximately* ordered across writers (clock skew). `readAll` and outbox `pending`/`deadLetters` query GSIs (eventually consistent); everything else reads strongly consistently.
- **Append is one `TransactWriteItems`**: conditional stream-head update (`attribute_not_exists(v)` for expected 0) + event puts (+ outbox puts with `appendWithOutbox`), ≤99 items. Condition failures map to `ConcurrencyConflict` with the actual version re-read; duplicate outbox ids inside the transaction die (nothing persists).
- **`ensureTables`** idempotently creates the table with `feed`/`status` GSIs + `exp` TTL (the DynamoDB replacement for `@structure-ai/migrations`); `layer` runs it before the stores.
- **Inbox** dedupe keys expire via TTL after 7 days (checked on read — TTL deletion may lag).
- **Errors**: SDK failures are classified (`throttling`/`internal` → transient `DynamoDbError`; the rest permanent).

Driver: `@effect-aws/dynamodb` (lib-dynamodb as an Effect service). Testing: the suite runs against DynamoDB Local (`DYNAMODB_ENDPOINT_URL`), skipped otherwise.

| Export | What it is |
| --- | --- |
| `layer(config)` | Document client + `ensureTables` + all five port adapters. |
| `storesLayer(options)` | The five adapters on an existing `DynamoDBDocumentService`. |
| `appendWithOutbox(...)` | Events + outbox messages in ONE transaction. |
| `ensureTables(options)` | Idempotent table/GSI/TTL bootstrap (needs `RawDynamoClient`). |
| `clientLayer(connection)` | The document-client layer from connection settings. |
| `ulid` / `ulidToPosition` / `positionToUlid` | The position codec. |
