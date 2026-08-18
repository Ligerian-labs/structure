---
name: create-view-model
description: Create a read model (view model) with its table migration and event-driven hydration in a @structure-based app. Use when a screen, API, or report needs shaped query data.
---

# Create a view model

View models are the query side: denormalized, shaped for one consumer, disposable (rebuildable from events). One table per view model, one writing projection per table. Reference: `packages/viewmodel/README.md`.

## Steps

1. **Define it** — Schema fields, an id field, one table:

```ts
import { ViewModel } from "@structure/viewmodel";
import { Schema } from "effect";

export const InvoiceListItem = ViewModel.define({
  name: "InvoiceListItem",
  fields: {
    id: Schema.String,
    status: Schema.Literal("pending", "approved", "rejected"),
    total: Schema.Number,
    approvedBy: Schema.optional(Schema.String),
  },
});
```

Shape it for the consumer (the screen/endpoint), not for the domain model — duplication across view models is fine.

2. **Add its table migration** to the app's migration set:

```ts
const migrations = makeSet([...existing, ViewModel.migration(InvoiceListItem, nextId)]);
```

3. **Hydrate it from events** with a `ViewProjection` — handlers receive the typed store:

```ts
import { ViewProjection } from "@structure/viewmodel";

export const invoiceList = ViewProjection.make({
  name: "invoice-list",
  view: InvoiceListItem,
  registry,
  when: {
    InvoiceApproved: (event, store) =>
      store.patch(event.invoiceId, { status: "approved", approvedBy: event.approver }),
  },
});
```

Run `invoiceList.catchup`/`run` in the worker; `invoiceList.rebuild` truncates the table and replays every event.

4. **Query it** in query handlers via the store: `get`/`findById`/`find(criteria, { orderBy, limit, offset })`/`count`. Never query the events or another context's tables for reads.
5. **Tests:** migration creates the table; append events → catchup → rows correct; catchup again → no double-apply; rebuild restores a corrupted row. Follow `packages/viewmodel/test/`.

## Rules

- The projection is the only writer; commands and queries never write view tables directly.
- Read models are eventually consistent — surface freshness in the product when it matters, don't pretend writes appear instantly.
- Schema changes to a view model = new migration + rebuild, not in-place hand-edits.

## Verify

`bun x tsc --noEmit && bun test` in the package.
