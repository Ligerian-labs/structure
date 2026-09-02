# Operations

How an app built on `@structure-ai/*` runs, and what to do when it misbehaves. Symptom-first where possible.

## Startup order (owned by `@structure-ai/runtime`)

1. Load + validate configuration — `ConfigLoadError` prints **every** issue and exits 1 before any work is accepted.
2. Initialize telemetry (`Observability.layer`; export is off when `OTLP_URL` is unset — the app still runs). One logger per process: `launch` disables `runMain`'s pretty logger and `layerJson` removes it as a backstop, so each record is printed once (`LOG_FORMAT=pretty` for a human-readable one locally).
3. Establish resources (SQL client, event store, buses, durable auth store/rate limiter when auth is enabled).
4. `Readiness.setReady` — only now does `/health/ready` return 200.

## Health

- `GET /health/live` — process responsive. Never coupled to dependency availability.
- `GET /health/ready` — the readiness flag AND every registered check; 503 returns the per-check report `{ready, checks:[{name, ok}]}`. Shutdown flips it unready before draining.

## Migrations policy

- Forward-only; each `run` is one transaction (all-or-nothing).
- Exactly **one** process per environment applies migrations at a time. Two supported postures:
  - **Deploy-step owner** (`lock: "transaction"`, the default): a deploy job, the `migrations up` CLI command, or a designated single writer's startup layer. A concurrent runner fails at once with `MigrationError("locked")` — that's the deploy step's signal, not a retry loop's. Every other instance starts without the migration layer.
  - **Replicas that boot together** (`lock: "session", waitFor`): every replica runs `layer(set, { lock: "session" })`; on Postgres exactly one takes the advisory lock and applies, the others block (bounded by `waitFor`, default 30 s) and then re-read the history — waiters become verifiers and end green with nothing to do. A waiter that times out fails `locked` and the orchestrator restarts it. Outside Postgres session mode is emulated by polling the non-blocking path until `waitFor`.
- Fail-closed: `run` and `status` compare the recorded history with the build's set by per-migration checksum, never by count or id alone. `unknown` rows (ids the build does not know — the database was migrated by a newer artifact, e.g. after a rollback) or `mismatched` checksums (a migration edited after it ran) make `run` refuse with `MigrationError("bad-state")` before applying anything, `migrations status` exit non-zero, and `migrationsReadinessCheck(set)` answer not ready — so an image older than its database never reports ready. Repair by rolling forward (deploy the newer artifact) or, for drift, restoring the migration as it ran and shipping the intended change as a new migration; never edit the bookkeeping table by hand.
- Serving instances that must never migrate register `migrationsReadinessCheck(set)` with `Readiness`: `/health/ready` stays 503 while anything is `pending`, `unknown` or `mismatched`.
- `migrations status` (or `status(set)`) answers "which migrations ran here" as `{ applied, pending, unknown, mismatched }`.
- Declare each migration's SQL (`defineMigration(id, name, up, { sql })`) so the checksum covers content, not just id and name; `ViewModel.migration` does this for generated tables. Upgrading from a release without checksums needs no action: the first `run` adds the column and adopts the current checksums for rows recorded before it existed.
- Incompatible changes: expand → migrate/backfill → switch readers/writers → contract, each step a separate migration, deployed separately.
- Auth schema: on Postgres, put `auth-pg`'s `migration(id)` in the application's single `makeSet` so the migrator applies it under the same lock and transaction as the event store, jobs, and view models; `auth-pg.migrate(sql)` (Bun `SQL`) and `auth-sqlite.migrate` are the all-in-one alternatives for apps without a set. Either way, one migration owner; serving processes construct `makeAuthStore` without migrating — the stores never create tables.
- `eventsourcing-pg.migrate` (run by its `layer` at build) also creates the `idempotency` table behind the cqrs `IdempotencyStore`; the same single-owner rule applies when several instances share the database.

## Shutdown

`Shutdown.trigger` (or SIGINT/SIGTERM, which `launch` routes into `trigger(<signal>)`) marks unready, then runs finalizers in reverse registration order, each bounded (default 5s — a hung finalizer is logged and skipped), inside an overall grace period (default 30s hard deadline). `awaitShutdown` resolves with the signal name once the drain completed; the program then ends, layers tear down (`serve` drops the listener here), and the process exits 0. A second signal ends the process at once. Register finalizers for: HTTP drain, projection/relay loops, SQL pools.

## Telemetry signals worth alerting on

| Signal | Meaning |
| --- | --- |
| `<boundary>_errors_total` rising vs `_calls_total` | A boundary (bus dispatch, HTTP, AI) is failing — check its span/logs via the shared correlationId |
| `http_request_duration_seconds{method,route,status}` p99 by `route` | One endpoint template is slow or erroring; `route="(unmatched)"` volume rising is scanning traffic. Labels are templates, never raw paths — a raw path in any label is a bug |
| Projection checkpoint vs latest event position | Read models are lagging; users see stale views |
| Outbox pending age / dead letters > 0 | Integration events not leaving; dead letters carry the last error text |
| `ai_tokens_*_total` spikes | LLM cost anomaly |
| Log records with `level: ERROR` | Every one carries the cause once, at the owning boundary |
| Auth rate-limit denials by stable action | Credential stuffing, mail abuse, or insufficient limiter capacity; never label by email/user/token |
| `http_rate_limit_blocked_total` by `route`, `http_rate_limit_store_errors_total` > 0 | Abuse or an under-sized budget on that route group; store errors mean the limiter is failing open (or closed, if configured) — check Redis |
| Auth dependency failures and OAuth provider latency | Mail/provider/storage degradation affecting sign-in journeys |
| Expired auth tokens/sessions/challenges awaiting cleanup | Retention job failure or store growth; raw bearer values must never be present |

## Recovery procedures

- **Stale or corrupted view model** — rebuild it: `viewProjection.rebuild(...)` truncates the table and replays every event with `live: false` (side-effect consumers must gate on `live`, so a rebuild never re-sends emails). Views are disposable by design.
- **Stuck outbox entry** — inspect `Outbox.deadLetters()` (last error included). Fix the cause; re-deliver by re-enqueueing a new entry. Dead-lettering is a diagnosis point, not a resolution.
- **Repeated `ConcurrencyConflict` on one aggregate** — a hot aggregate. `executeWithRetry` absorbs incidental races; sustained conflict is a modeling signal (aggregate too big), not a retry-tuning problem.
- **Poisoned event (fails a projection handler)** — the projection halts at its checkpoint (at-least-once, pre-checkpoint failure). Fix the handler or add an upcaster for the event's schema version, redeploy, and the projection resumes from the checkpoint.
- **Duplicate deliveries downstream** — verify the consumer wraps effects in `Inbox.dedupe`; the transport is at-least-once on purpose.
- **Idempotency table growth or a key stuck `InFlight` (409)** — records expire after `idempotencyTtl` (default 24 hours, measured from the last claim or completion); schedule `purgeExpiredIdempotency` to reclaim space. A claim survives only a crash mid-dispatch (failures and timeouts release it): the key is refused as in flight until the TTL passes — callers use a new key, or shorten the TTL to the retry window. Never shrink the TTL below the longest legitimate client retry span, or replays become duplicates.
- **Auth token/session store growth** — delete expired digests and consumed tombstones with a bounded tenant-aware job. Never inspect or log raw incoming bearer values while diagnosing cleanup.
- **OAuth provider outage** — preserve password, magic-link, and passkey paths; provider HTTP has one bounded attempt and no nested retry. Alert on the provider/action aggregate, not identities.
- **Suspected credential compromise** — revoke all user sessions atomically, rotate affected OAuth/provider/mail credentials, preserve safe audit events, and follow the application's user notification procedure.

## Environments

No environment-name branching anywhere: behavior differences ride on explicit settings (`Settings.*`), documented per package via `Settings.renderDocs`. Secrets enter as env vars, load as `Redacted`, and never appear in logs, traces, or errors. An env var set to an empty or whitespace-only value counts as unset (`docker compose` forwards `VAR=${VAR:-}` as `VAR=`): the setting's default applies and `optional` settings load `None`; `blankMeansUnset: false` on `load` keeps the literal empty string.

One such setting deserves a warning: the `trustProxy` flag passed to `clientIp` (HTTP rate limiting). Keep it `false` unless a proxy you operate terminates every connection and appends the client address to `x-forwarded-for`; with it on, a directly reachable replica lets any client choose its own rate-limit bucket.
