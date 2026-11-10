# @structure-ai/auth-dynamodb

Durable `AuthStore` over the DynamoDB single table (ADR-0015): no extra indexes — every lookup is a designed key; uniqueness is item existence (companion index items written in the same transaction); one-time tokens/states/challenges are consumed atomically by `Delete` with `ReturnValues=ALL_OLD`.

## Usage

```ts
import { makeAuthStore } from "@structure-ai/auth-dynamodb";
import { makeAuth } from "@structure-ai/auth";

const store = yield* makeAuthStore({ tableName: "structure" });
const auth = makeAuth({ store, resolveTenant, emailSender, rateLimiter, ... });
```

- **Keys**: users `A#<t>#U#<uid>`; email map + password `A#<t>#E#<email>` (E/P); sessions `A#<t>#S#<hash>` + user index `A#<t>#SU#<uid>`; oauth identities `A#<t>#I#<provider>#<subject>` + per-user index `A#<t>#UI#<uid>`; passkeys `A#<t>#K#<credentialId>` + user index; tokens/states/challenges keyed by hash; totp enrollment `A#<t>#TOTP#<uid>`.
- **Conflicts**: duplicate email/provider-identity/passkey-counter CAS failures surface as `IdentityConflict`; everything else is a transient `AuthStoreError`.
- **Tokens**: `putOneTimeToken` replaces the current token per (tenant, purpose, email) — pointer item + delete-old in one transaction; consuming the replaced hash yields `undefined`, expiry checked on consume.
- **TOTP/2FA**: single item per (tenant, user); `confirmTotp` is a conditional update (pending→confirmed), `markTotpStepUsed` a compare-and-set that rejects replayed or backwards steps, `consumeRecoveryCode` compare-and-deletes from the hash list, `recordTotpFailure` counts to a caller-supplied threshold then locks with a cooldown; `elevateSession` stamps `elevatedAt` on the session item.

The table must exist (the eventsourcing `layer` creates it). Testing runs against DynamoDB Local (`DYNAMODB_ENDPOINT_URL`).

| Export | What it is |
| --- | --- |
| `makeAuthStore(options)` | The `AuthStore` over an existing `DynamoDBDocumentService`. |
