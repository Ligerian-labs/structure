# Contributing

Contributions are welcome from humans and coding agents alike — the bar is the same for both: small, verified, convention-following changes. The machine-readable conventions live in [AGENTS.md](AGENTS.md) (agents: read it first; `CLAUDE.md` imports it automatically). The package index is [llms.txt](llms.txt).

## Setup

```sh
bun install
bun run lint && bun run typecheck && bun run test   # must be green before you start
```

Bun ≥ 1.3 (isolated workspace installs). Postgres tests skip unless `DATABASE_URL` is set; CI runs them against a real Postgres.

## Workflow

1. **Open or pick an issue** describing the problem (bug template wants a minimal repro; feature template wants an API sketch and design-rule fit). For anything beyond a small fix, agree on the approach in the issue before writing code.
2. **Branch** from `main`: `type/short-description` (e.g. `feat/viewmodel-indexes`, `fix/outbox-retry-jitter`).
3. **Write the tests first**, mapping to the issue's acceptance criteria; confirm each fails on the asserted behavior, not on setup errors. Bug fixes start from a failing repro that remains as a regression test.
4. **Implement**, keeping the change minimal and inside one package where possible.
5. **Verify** — the same gates CI runs:
   - `bun run lint` (Biome), `bun run typecheck` (tsc per package), `bun run test` (bun test per package), all from the root;
   - per-package while iterating: `bun x tsc --noEmit` and `bun test` inside `packages/<name>`.
6. **Commit**: conventional commits, single line, no trailers of any kind — `feat(viewmodel): add secondary indexes`. Types: `feat` `fix` `docs` `style` `refactor` `test` `chore`.
7. **Open the PR** using the template: what & why, acceptance criteria, per-package changes, verification checklist. CI enforces the conventional title, lint, typecheck, tests, and the Postgres suite.

## What a good change looks like

- **Respects the dependency direction** (see AGENTS.md) — no new cycles, no reaching across bounded layers.
- **Typed errors**: `Data.TaggedError` with a `classification` field (`transient` | `permanent` | `conflict`); no `any`, no non-null assertions (Biome blocks both).
- **Dependencies**: versions come from the root `package.json` `workspaces.catalog` (`"catalog:"`), internal deps are `"workspace:*"`. Adding a *new* external dependency needs justification in the PR — prefer composing what's already there.
- **Public API changes** update the package `README.md` and the `llms.txt` line, and stay documented with JSDoc that states constraints, not restatements of names.
- **Tests over claims**: no network, no real LLM providers (use `TestModel`), sqlite `:memory:` for SQL, pg suites gated on `DATABASE_URL`. A PR whose verification section says "should work" is not done.

## Notes for coding agents

- Read `AGENTS.md`, then the README of every package you touch. Task recipes (create an aggregate, a command, a view model, a migration…) are in `.claude/skills/*/SKILL.md` — follow them for matching tasks.
- Effect APIs move fast: verify signatures against `packages/<pkg>/node_modules/<dep>/dist/dts/*.d.ts`. IDE/LSP diagnostics in this repo are unreliable; only `tsc` and `bun test` count.
- State what you verified versus what you inferred; flag uncertainty as `[inferred — verify]` in issues and PR bodies.
- Do not include AI/generated-by attribution in commits, PR titles, or bodies.
- If the change grows beyond what the issue agreed (new domain concept, schema change, cross-cutting concern), stop and take it back to the issue instead of expanding the PR.

## Releases

Releases are tag-driven and lockstep (`.github/workflows/release.yml`). Pushing a tag `vX.Y.Z` (or `vX.Y.Z-rc.N` for a prerelease):

1. re-runs every verification gate (lint, typecheck, all tests including the Postgres suite);
2. stamps the tag version into every `packages/*/package.json` — the repo itself stays at `0.0.0`, versions exist only on tags;
3. publishes all packages to npm in dependency order with `bun publish` (`workspace:*` and `catalog:` are resolved to real versions at pack time; packages ship as TypeScript source — no build step);
4. creates a GitHub release with generated notes.

Prereleases (any version with a `-` suffix) publish under the `next` dist-tag and are marked prerelease on GitHub. Already-published versions are skipped, so a failed run can be re-run safely. The workflow needs an `NPM_TOKEN` repository secret with publish rights on the npm scope.

Regular PRs never bump versions and don't add build tooling; propose pipeline changes in an issue first.
