---
name: install
description: Make the repository's .agents/skills discoverable by tools that need compatibility links (Claude Code reads .claude/skills). Use when a tool reports the repo's task skills as missing.
---

# Install skill discovery

Canonical task skills live in `.agents/skills/*/SKILL.md` — the cross-agent directory discovered by Pi, Codex, Cursor, OpenCode, OpenClaw, and others. Claude Code only reads `.claude/skills/`, so it needs a compatibility symlink. One link covers every skill; never copy skill files.

## Steps

1. **Create the symlink** from the repository root:

```sh
mkdir -p .claude
ln -s ../.agents/skills .claude/skills
```

   The relative target keeps the link valid wherever the repo is cloned.

2. **Verify**: `ls .claude/skills/` lists the same skills as `.agents/skills/` (21 directories at time of writing).
3. **No other setup**: tools reading `.agents/skills/` natively need nothing; `.claude/` is gitignored, so the link stays a local convenience and never appears in diffs.
4. **Add new skills once**, under `.agents/skills/<name>/SKILL.md` — every linked tool sees them; update the skill list in `AGENTS.md` and `llms.txt` in the same change.

## Rules

- `.agents/skills/` is the single source of truth; symlinks point at it, nothing duplicates it.
- Never commit `.claude/` (gitignored); never commit a copied skills tree.
- Remove the link with `rm .claude/skills && rmdir .claude` when it is no longer needed.
