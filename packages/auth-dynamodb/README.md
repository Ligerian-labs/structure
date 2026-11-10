# @structure-ai/auth-dynamodb

Durable `AuthStore` over the DynamoDB single table (ADR-0015): no extra indexes — every lookup is a designed key; uniqueness is item existence (companion index items written in the same transaction); one-time tokens/states/challenges are consumed atomically by `Delete` with `ReturnValues=ALL_OLD`.

## Usage

```ts
import { makeAuthStore } from "@structure-ai/auth-dynamodb";
import { makeAuth } from "@structure-ai/auth";

const store = yield* makeAuthStore({ tableName: "structure" });
const auth = makeAuth({ store, resolveTenant, emailSender, rateLimiter, ... });
```

- **Keys**: users `A#<t>#U#<uid>`; email map + password `A#<t>#E#<email>` (E/P); sessions `A#<t>#S#<hash>` + user index `A#<t>#SU#<uid>`; oauth identities `A#<t>#I#<provider>#<subject>`; passkeys `A#<t>#K#<credentialId>` + user index; tokens/states/challenges keyed by hash.
- **Conflicts**: duplicate email/provider-identity/passkey-counter CAS failures surface as `IdentityConflict`; everything else is a transient `AuthStoreError`.
- **Tokens**: `putOneTimeToken` replaces the current token per (tenant, purpose, email) — pointer item + delete-old in one transaction; consuming the replaced hash yields `undefined`, expiry checked on consume.

The table must exist (the eventsourcing `layer` creates it). Testing runs against DynamoDB Local (`DYNAMODB_ENDPOINT_URL`).

| Export | What it is |
| --- | --- |
| `makeAuthStore(options)` | The `AuthStore` over an existing `DynamoDBDocumentService`. |
