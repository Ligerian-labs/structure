# structure — documentation

Living documentation for the framework. "Living" means every document here has a single owner-topic, is updated **in the same PR** as the behavior it describes, and never duplicates what a closer-to-code source already owns.

## What lives where

| Question | Source of truth |
| --- | --- |
| What does package X's API look like? | `packages/<x>/README.md` (exports table + usage) |
| How do I call it, exactly? | `packages/<x>/test/` — tests are the executable examples |
| How do the packages compose into an app? | [getting-started.md](getting-started.md) |
| Why is the system shaped this way? | [architecture.md](architecture.md) + [decisions/](decisions/) (ADRs) |
| How do I run, migrate, observe, and recover it? | [operations.md](operations.md) |
| What are the repo conventions and hard rules? | [`AGENTS.md`](../AGENTS.md) |
| How do I contribute? | [`CONTRIBUTING.md`](../CONTRIBUTING.md) |
| Machine-readable package index | [`llms.txt`](../llms.txt) |
| Step-by-step task recipes | `.agents/skills/*/SKILL.md` |

## Contents

- [getting-started.md](getting-started.md) — build one small app end to end: config → domain → command → event sourcing → view model → HTTP → launch.
- [architecture.md](architecture.md) — the flow of a command through the system, package dependency direction, the consistency model, and the error taxonomy.
- [operations.md](operations.md) — startup order, migration policy, health, shutdown, telemetry signals, and recovery procedures (projection rebuilds, outbox dead letters).
- [decisions/](decisions/) — architecture decision records: numbered, immutable once accepted, superseded rather than edited.

## Rules for this directory

- A PR that changes cross-package behavior, a contract, or an operational procedure updates the matching doc **in the same PR** (the PR template asks for it).
- Don't paste API signatures here — link to the package README; signatures pasted twice drift twice.
- Significant design choices get an ADR (copy [decisions/0000-template.md](decisions/0000-template.md)); reversing one gets a *new* ADR that marks the old one superseded.
