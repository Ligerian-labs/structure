# @structure-ai/viewmodel-dynamodb

`ViewStore` over the DynamoDB single table: **declared access patterns** become sparse composite-key GSIs; queries outside the declared patterns fail loudly (`UndeclaredAccessPattern`) instead of hoping for a scan (ADR-0015).

## Usage

```ts
import { makeWithIndexes } from "@structure-ai/viewmodel-dynamodb";

const OrderView = ViewModel.define({
  name: "order",
  fields: { id: Schema.String, tenantId: Schema.String, status: Schema.String, total: Schema.Number },
});

const store = yield* makeWithIndexes(OrderView, {
  tableName: "structure",
  patterns: {
    byTenant: { partition: ["tenantId"] },
    byTenantStatus: { partition: ["tenantId", "status"] },
  },
});
await store.find({ tenantId: "acme", status: "paid" }); // resolves byTenantStatus
await store.find({ status: "paid" }); // UndeclaredAccessPattern — design it, don't scan
```

- Rows are items (`pk V#<view>#<id>`); each declared pattern adds a GSI whose key attributes are computed on upsert — null pattern fields leave the index (sparse).
- `find` picks the most specific matching pattern (partition ⊆ criteria), filters leftovers client-side, then sorts/pages client-side (`orderBy`/`order`/`limit`/`offset` — offset over-fetches, documented cost).
- `makeWithIndexes` = `ensureViewIndexes` (one online GSI build at a time) + `make`. The table must exist (the eventsourcing `layer` creates it).

| Export | What it is |
| --- | --- |
| `make(def, options)` | The store over an existing `DynamoDBDocumentService`. |
| `makeWithIndexes(def, options)` | `ensureViewIndexes` + `make`. |
| `ensureViewIndexes(options, viewName)` | Idempotent GSI lifecycle (needs `RawDynamoClient`). |
| `UndeclaredAccessPattern` | The loud failure for undesigned queries (permanent). |
