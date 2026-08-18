<!-- Title must follow conventional commits: type(scope): description (CI enforces it). -->

## What & why

<!-- Summarize what changed and why. Link the issue: Closes #NN. -->

## Acceptance criteria

<!-- The observable behaviors this PR delivers; each should map to a test below. -->

- [ ] …

## Changes

<!-- Per package touched, one or two lines. Call out any contract change (exported API, event schema, table shape, error type). -->

## Verification

- [ ] `bun run lint` clean at root
- [ ] `bun run typecheck` clean at root
- [ ] `bun run test` green at root
- [ ] New behavior is covered by tests that fail without the change (bug fixes: the repro stays as a regression test)
- [ ] Package `README.md` and `llms.txt` updated if the public API changed
- [ ] `docs/` updated in this PR if cross-package behavior, a contract, or an operational procedure changed (new ADR for significant design choices — see `docs/index.md`)
- [ ] No new dependency outside the root catalog; dependency direction (AGENTS.md) respected

<!-- Do not include AI/generated-by attribution in the title, body, or commits. -->
