# ADR-0011: Task skills live in the cross-agent `.agents/skills` directory

- Status: accepted
- Date: 2026-08-26

## Context

ADR-0008 made the repository a first-class interface for coding agents and placed task recipes in `.claude/skills/` — a Claude Code-specific location. The repo is consumed by several agents (Pi, Codex, Cursor, OpenCode, OpenClaw) that discover `.agents/skills/` natively and do not read `.claude/`; Claude Code reads only `.claude/skills/`. Maintaining skill files in a tool-specific directory either locks out other agents or forces duplicated copies, and the original eight skills left most packages (config, observability, http, runtime, cli, ai, auth, the SQL adapters) without task recipes.

## Decision

Skills live canonically in `.agents/skills/<name>/SKILL.md` — one directory, every skill, no duplicates — and the set covers every package in the monorepo's package map plus cross-cutting tasks (settings, observability, HTTP, runtime, CLI, LLM calls, authentication, durable adapters, context integration, reading app state). Claude Code compatibility is a local, untracked symlink (`.claude/skills -> ../.agents/skills`), created on demand by the `install` skill; `.claude/` is gitignored.

## Consequences

Every agent reads the same skill files with zero duplication; adding a skill is a single write under `.agents/skills/`. Claude Code users run the `install` skill once per clone (or maintain no link and use a different agent). Skill discovery depends on each tool's `.agents/` support staying current; a tool that supports neither directory would need a new compatibility mechanism. Revisit if a widely used agent standard other than `.agents/skills/` emerges, or if skill files outgrow per-package recipes and need indexing.
