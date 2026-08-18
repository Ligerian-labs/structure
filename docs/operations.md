# Operations

How an app built on `@structure/*` runs, and what to do when it misbehaves. Symptom-first where possible.

## Startup order (owned by `@structure/runtime`)

1. Load + validate configuration — `ConfigLoadError` prints **every** issue and exits 1 before any work is accepted.
2. Initialize telemetry (`Observability.layer`; export is off when `OTLP_URL` is unset — the app still runs).
3. Establish resources (SQL client, event store, buses).
4. `Readiness.setReady` — only now does `/health/ready` return 200.

## Health

- `GET /health/live` — process responsive. Never coupled to dependency availability.
- `GET /health/ready` — the readiness flag AND every registered check; 503 returns the per-check report `{ready, checks:[{name, ok}]}`. Shutdown flips it unready before draining.

## Migrations policy

- Forward-only; each `run` is one transaction (all-or-nothing); concurrent runners fail `MigrationError("locked")` — that's the deploy step's signal, not a retry loop's.
- Exactly **one** process per environment may migrate: a deploy job, the `migrations up` CLI command, or a designated single writer's startup layer. Every other instance starts without the migration layer.
- `migrations status` (or `status(set)`) answers "which migrations ran here".
- Incompatible changes: expand → migrate/backfill → switch readers/writers → contract, each step a separate migration, deployed separately.

## Shutdown

`Shutdown.trigger` (or SIGINT/SIGTERM via `launch`) marks unready, then runs finalizers in reverse registration order, each bounded (default 5s — a hung finalizer is logged and skipped), inside an overall grace period (default 30s hard deadline). Register finalizers for: HTTP drain, projection/relay loops, SQL pools.

## Telemetry signals worth alerting on

| Signal | Meaning |
| --- | --- |
| `<boundary>_errors_total` rising vs `_calls_total` | A boundary (bus dispatch, HTTP, AI) is failing — check its span/logs via the shared correlationId |
| Projection checkpoint vs latest event position | Read models are lagging; users see stale views |
| Outbox pending age / dead letters > 0 | Integration events not leaving; dead letters carry the last error text |
| `ai_tokens_*_total` spikes | LLM cost anomaly |
| Log records with `level: ERROR` | Every one carries the cause once, at the owning boundary |

## Recovery procedures

- **Stale or corrupted view model** — rebuild it: `viewProjection.rebuild(...)` truncates the table and replays every event with `live: false` (side-effect consumers must gate on `live`, so a rebuild never re-sends emails). Views are disposable by design.
- **Stuck outbox entry** — inspect `Outbox.deadLetters()` (last error included). Fix the cause; re-deliver by re-enqueueing a new entry. Dead-lettering is a diagnosis point, not a resolution.
- **Repeated `ConcurrencyConflict` on one aggregate** — a hot aggregate. `executeWithRetry` absorbs incidental races; sustained conflict is a modeling signal (aggregate too big), not a retry-tuning problem.
- **Poisoned event (fails a projection handler)** — the projection halts at its checkpoint (at-least-once, pre-checkpoint failure). Fix the handler or add an upcaster for the event's schema version, redeploy, and the projection resumes from the checkpoint.
- **Duplicate deliveries downstream** — verify the consumer wraps effects in `Inbox.dedupe`; the transport is at-least-once on purpose.

## Environments

No environment-name branching anywhere: behavior differences ride on explicit settings (`Settings.*`), documented per package via `Settings.renderDocs`. Secrets enter as env vars, load as `Redacted`, and never appear in logs, traces, or errors.
