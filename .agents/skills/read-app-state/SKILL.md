---
name: read-app-state
description: Read application state in a @structure-based app - view models, aggregate state, projection lag, migration status, health. Use when answering "what is the current state of X".
---

# Read application state

Pick the right surface — each question has one authoritative answer:

| Question | Read from |
| --- | --- |
| "What does the user/API see?" | The view model: `ViewStore` `get`/`find`/`count` (`@structure-ai/viewmodel`). Eventually consistent. |
| "What is the authoritative state of one aggregate right now?" | `AggregateStore.load(id)` (`@structure-ai/eventsourcing`) — folds the full event history; returns `{ state, version }`. |
| "What happened, in order?" | `EventStore.read(stream)` / `readAll` — the events are the source of truth. |
| "Is a projection caught up?" | Its checkpoint (`CheckpointStore.load(name)`) vs the store's latest global position; `catchup` returns `{ processed, skipped }`. |
| "Are outbox messages stuck?" | `Outbox.pending(limit)` and `Outbox.deadLetters()` — dead letters carry the last error. |
| "Which migrations ran?" | `status(set)` from `@structure-ai/migrations` → `{ applied, pending, unknown, mismatched }` (`unknown` = database ahead of this build, `mismatched` = checksum drift), or `<app> migrations status` (exits non-zero on those two). |
| "Is the process healthy?" | `/health/live`, `/health/ready` (`@structure-ai/http`) — ready includes the per-check report. |

## Rules

- Queries go through `QueryBus` handlers reading view stores — never invoke aggregate behavior just to format a response, and never read another bounded context's tables.
- Don't rebuild state by folding events in ad-hoc code; use `AggregateStore.load` (it honors snapshots and the registry's upcasters).
- Read-your-own-write needs: return the command ack (id + version), or poll the view store for that version with a timeout — don't pretend projections are synchronous.
- For operator questions prefer the exposed surfaces (health endpoint, migrations status, metrics) over raw SQL against production tables.

## In code vs. at the shell

- In code/tests: compose the Effects above with the app's layers.
- Interactively against a local sqlite db: `bun repl`-style scripts are fine, or query the tables directly (`events`, `checkpoints`, `outbox`, view tables) — read-only.
