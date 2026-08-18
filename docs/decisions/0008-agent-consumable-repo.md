# ADR-0008: The repository is a first-class interface for coding agents

- Status: accepted
- Date: 2026-08-18

## Context

The framework targets agentic software, and its contributors and consumers include coding agents. Agents fail predictably when conventions are implicit, docs drift from code, or discovery requires tribal knowledge.

## Decision

Agent consumption is designed in: `AGENTS.md` is the single conventions document (`CLAUDE.md` imports it); `llms.txt` is the machine-readable package index; every package has a uniformly-structured README with its tests as executable examples; task recipes live in `.claude/skills/*/SKILL.md`; issue/PR templates use structured fields agents can fill; `docs/` holds the cross-package narrative under an update-in-the-same-PR policy.

## Consequences

- The same artifacts serve humans and agents — there is no separate "agent docs" to drift.
- Known environment quirks are written down where agents will hit them (verify APIs against installed `.d.ts`; IDE diagnostics in this repo are noise; only `tsc` + `bun test` count).
- Documentation discipline costs are paid on every PR (checklist-enforced) instead of accruing as rot.
- No AI-attribution trailers anywhere: contributions are judged by the same gates regardless of author.
