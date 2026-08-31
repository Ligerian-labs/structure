# Getting started

One small application, end to end: a bank `Account` that accepts deposits, projected into a queryable view, exposed over HTTP with OpenAPI docs and health probes. Each step names the package that owns it; exact signatures live in that package's README and tests.

## 1. Settings (`@structure-ai/config`)

```ts
import { Settings } from "@structure-ai/config";
import { observabilitySettings } from "@structure-ai/observability";

export const settings = Settings.struct({
  http: Settings.nested("HTTP", Settings.struct({ port: Settings.port("PORT", { default: 3000 }) })),
  obs: observabilitySettings,
});
```

Loading validates everything at startup and reports **all** problems before the app accepts work.

## 2. Domain (`@structure-ai/domain`)

```ts
import { Aggregate, DomainEvent, EntityId, InvariantViolation } from "@structure-ai/domain";
import { Effect, Schema } from "effect";

export const AccountId = EntityId.define("AccountId");

export const AccountOpened = DomainEvent.define("AccountOpened", { accountId: AccountId.schema });
export const MoneyDeposited = DomainEvent.define("MoneyDeposited", {
  accountId: AccountId.schema,
  amount: Schema.Number.pipe(Schema.positive()),
});
type AccountEvent = typeof AccountOpened.Type | typeof MoneyDeposited.Type;

interface AccountState { readonly opened: boolean; readonly balance: number }
type AccountCommand =
  | { readonly _tag: "OpenAccount"; readonly id: EntityId.Of<typeof AccountId> }
  | { readonly _tag: "Deposit"; readonly id: EntityId.Of<typeof AccountId>; readonly amount: number };

export const Account = Aggregate.define<AccountState, AccountCommand, AccountEvent, InvariantViolation>({
  name: "Account", // no "-" — it prefixes event stream names
  initial: { opened: false, balance: 0 },
  decide: (state, command) => {
    switch (command._tag) {
      case "OpenAccount":
        return state.opened
          ? Effect.fail(new InvariantViolation({ rule: "account already open" }))
          : Effect.succeed([AccountOpened.make({ accountId: command.id })]);
      case "Deposit":
        return state.opened
          ? Effect.succeed([MoneyDeposited.make({ accountId: command.id, amount: command.amount })])
          : Effect.fail(new InvariantViolation({ rule: "account not open" }));
    }
  },
  evolve: (state, event) =>
    event._tag === "AccountOpened"
      ? { ...state, opened: true }
      : { ...state, balance: state.balance + event.amount },
});
```

## 3. Event persistence (`@structure-ai/eventsourcing` + an adapter)

```ts
import { AggregateStore, EventRegistry } from "@structure-ai/eventsourcing";

export const registry = EventRegistry.make([
  { schema: AccountOpened, schemaVersion: 1 },
  { schema: MoneyDeposited, schemaVersion: 1 },
]);
// inside a handler: const store = yield* AggregateStore.make(Account, registry);
// store.executeWithRetry(id, command, { correlationId }) — retries only ConcurrencyConflict
```

Provide the ports with `InMemoryAll` (tests) or the all-in-one sqlite/pg layer (`@structure-ai/eventsourcing-sqlite` / `-pg`).

## 4. Command (`@structure-ai/cqrs`)

```ts
import { Command, CommandHandler, HandlerRegistry, layer as cqrsLayer } from "@structure-ai/cqrs";
import { Effect, Schema } from "effect";

export const Deposit = Command.define("Deposit", {
  payload: Schema.Struct({ accountId: Schema.String, amount: Schema.Number }),
  success: Schema.Struct({ accountId: Schema.String, version: Schema.Number }),
});

export const handlers = HandlerRegistry.layer(
  CommandHandler.make(Deposit, (payload) =>
    Effect.gen(function* () {
      const store = yield* AggregateStore.make(Account, registry);
      const id = AccountId.make(payload.accountId);
      const result = yield* store.executeWithRetry(id, { _tag: "Deposit", id, amount: payload.amount });
      return { accountId: payload.accountId, version: result.version };
    }),
  ),
);
// bus stack: cqrsLayer (both buses + allow-all authorizer + in-memory idempotency) provided with `handlers`
```

The bus validates payload shape, authorizes the action, handles idempotency keys, and traces the dispatch — the handler stays thin.

One wiring rule: `HandlerRegistry.layer` captures each handler's service requirements from the context when the registry layer is built, and the requirements then disappear from the types. Compose every layer that satisfies them with `Layer.provideMerge`, never plain `Layer.provide`: `provide` spends the services building the registry, so they are missing from the runtime context, and anything else that needs them (the HTTP bridge, a projection worker, direct store access) fails with a missing-service defect at dispatch — far from the wiring that caused it.

To authorize for real, declare a policy and build the bus `Authorizer` from it (`@structure-ai/authorization`); the HTTP layer attaches the caller's `Principal` per request and the same policy guards any route or tool:

```ts
import { CqrsAuthorization, HttpAuthorization, Policy } from "@structure-ai/authorization";

export const policy = Policy.define({
  resources: { account: ["deposit", "read"] },
  roles: { teller: { grants: ["account:deposit", "account:read"] }, auditor: { grants: ["account:read"] } },
});
const AuthorizerLive = CqrsAuthorization.rules(policy).message(Deposit, "account:deposit").layer; // replaces Authorizer.allowAll
const PrincipalLive = HttpAuthorization.layer(HttpAuthorization.fromBearer(lookupSession)); // token → Option<Principal>
```

## 5. Read model (`@structure-ai/viewmodel` + `@structure-ai/migrations`)

```ts
import { makeSet } from "@structure-ai/migrations";
import { ViewModel, ViewProjection } from "@structure-ai/viewmodel";
import { Schema } from "effect";

export const AccountView = ViewModel.define({
  name: "AccountView",
  fields: { id: Schema.String, balance: Schema.Number },
});

export const migrations = makeSet([ViewModel.migration(AccountView, 1)]);

export const accountsProjection = ViewProjection.make({
  name: "accounts",
  view: AccountView,
  registry,
  when: {
    AccountOpened: (event, store) => store.upsert({ id: event.accountId, balance: 0 }),
    MoneyDeposited: (event, store) =>
      Effect.flatMap(store.get(event.accountId), (row) =>
        store.upsert({ ...row, balance: row.balance + event.amount }),
      ),
  },
});
// worker: accountsProjection.run(...) · full rebuild: accountsProjection.rebuild(...)
```

Queries read `ViewStore.make(AccountView)` — never the event streams.

## 6. HTTP (`@structure-ai/http`)

Declare the api with the `Api`/`ApiGroup` helpers, mount the command via the CQRS bridge (`HttpCqrs.command(Deposit)` as the endpoint handler), and compose `Health.layer` (readiness-backed `/health/*`) and `Docs.layer` (`/docs` + `/openapi.json`). `serve({ port })` runs it on Bun with graceful shutdown. The complete, working wiring is `packages/http/test/http.test.ts` — copy it.

## 7. Launch (`@structure-ai/runtime`)

```ts
import { load } from "@structure-ai/config";
import * as Observability from "@structure-ai/observability";
import { launch } from "@structure-ai/runtime";
import { run as runMigrations } from "@structure-ai/migrations";
```

`launch(program, { layers })` boots in the production order — validate config (all errors at once, exit 1) → telemetry → resources → ready — and drains within a grace period on shutdown. Run `runMigrations(migrations)` only in the process your deployment policy allows (deploy job, `migrations up` CLI command, or the single writer's startup).

## 8. Verify

Every step above has a test-shaped equivalent in the owning package's `test/` directory — start from those when writing your app's tests: in-memory event store, `TestModel` for LLM calls, sqlite `:memory:` for SQL, no network.
