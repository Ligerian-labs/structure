# @structure-ai/viewmodel

The query side of CQRS as a deliberately small "ORM": a view model is a Schema-defined row in one table, with a typed store, a generated table migration, and hydration from domain events. Not a general ORM — no relations, no lazy loading, no change tracking. Read models are denormalized, shaped per consumer, and disposable: any of them can be rebuilt from the event history.

## Usage

```ts
import { ViewModel, ViewProjection, ViewStore } from "@structure-ai/viewmodel";
import { makeSet } from "@structure-ai/migrations";
import { Effect, Schema } from "effect";

const AccountView = ViewModel.define({
  name: "AccountView", // table: account_view
  fields: {
    id: Schema.String,
    balance: Schema.Number,
    frozen: Schema.Boolean,
    tags: Schema.Array(Schema.String), // stored as JSON TEXT
  },
});

// 1. the table enters your migration set:
const migrations = makeSet([ViewModel.migration(AccountView, 1)]);

// 2. hydration from events:
const accounts = ViewProjection.make({
  name: "accounts", // checkpoint identity
  view: AccountView,
  registry, // EventRegistry with AccountOpened / MoneyDeposited ...
  when: {
    AccountOpened: (event, store) =>
      store.upsert({ id: event.accountId, balance: 0, frozen: false, tags: [] }),
    MoneyDeposited: (event, store) =>
      store.patch(event.accountId, { balance: /* prev + amount via get/patch */ }),
  },
});
// worker: accounts.run(...)  ·  tests/batch: accounts.catchup(...)  ·  accounts.rebuild(...) = truncate + full replay

// 3. queries read the typed store:
const program = Effect.gen(function* () {
  const store = yield* ViewStore.make(AccountView);
  const account = yield* store.get("acc-1"); // Effect<A, NotFound>
  const frozen = yield* store.find({ frozen: true }, { orderBy: "balance", order: "desc", limit: 20 });
});
```

## Exports

| Export | What it is |
| --- | --- |
| `ViewModel.define({ name, table?, idField?, fields })` | Definition: Schema fields → columns (snake_case names, portable SQL types derived from the schema AST). Throws `InvalidViewModel` listing every problem. `ViewModel.Of<typeof def>` / `EncodedOf` type helpers. |
| `ViewModel.createTableSql(def)` / `ViewModel.migration(def, id)` | Generated DDL (`CREATE TABLE IF NOT EXISTS`, PK on the id column) as a string or as a `@structure-ai/migrations` migration. |
| `ViewStore.make(def)` / `ViewStore.layer(tag, def)` | Typed store over `SqlClient`: `get` (fails `NotFound`), `findById`, `find(criteria, { orderBy, order, limit, offset })`, `findOne`, `count`, `upsert`/`upsertMany` (ON CONFLICT id DO UPDATE), `patch` (read-merge-write; the projection is the single writer), `remove` (idempotent), `truncate`. Criteria are equality-AND on encoded values; `null` compiles to `IS NULL`. |
| `ViewProjection.make({ name, view, registry, when })` | Hydration built on `@structure-ai/eventsourcing` projections: handlers `(event, store, { stored, live })`; returns `{ projection, catchup, run, rebuild }` — `rebuild` truncates the table and replays with `live: false`. |

## Storage classes

string/string-literals → `TEXT` · number → `DOUBLE PRECISION` · `Schema.Int` → `INTEGER` · boolean → `BOOLEAN` · `DateTimeUtc`/`Date` → `TEXT` (ISO) · everything else → `TEXT` storing JSON. `Schema.NullOr`/`Schema.optional` drop `NOT NULL`. Types are pg-valid; sqlite accepts them all. Reads normalize driver quirks (sqlite `0/1` booleans, pg stringified numbers) before schema decode.

## Rules

- One view table has exactly one writing projection; commands and queries never write view tables directly.
- View models are eventually consistent — expose freshness where it matters instead of pretending writes are synchronous.
- Changing a view model's shape = new migration + `rebuild`, not in-place edits.
