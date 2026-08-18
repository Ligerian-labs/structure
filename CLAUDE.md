# structure — instructions for coding agents

Effect-based framework monorepo. Bun workspaces (isolated installs: each package resolves deps via its own `node_modules`), Turborepo, Biome, TypeScript strict.

## Commands
- Install: `bun install` (root). Verify all: `bun run lint && bun run typecheck && bun run test` (root).
- Per package (run inside `packages/<name>`): `bun x tsc --noEmit`, `bun test`.
- Format/lint fix: `bun x biome check --write <path>` from root.

## Hard rules
- Effect v3 APIs move fast: verify signatures against `packages/<pkg>/node_modules/<dep>/dist/dts/*.d.ts` before using unfamiliar APIs.
- ESM only; local imports use the `.js` suffix; `exports` maps point at TypeScript source (`./src/index.ts`) — no build step.
- Shared dependency versions live in the root `package.json` `workspaces.catalog`; packages reference them as `"catalog:"`. Internal deps are `"workspace:*"`.
- No `any`, no non-null assertions (Biome errors). Tagged errors (`Data.TaggedError`) with a `classification` field (`transient` | `permanent` | `conflict`).
- Dependency direction (no cycles): config ← observability ← everything; domain ← cqrs ← eventsourcing ← sql adapters; runtime ← http/cli; ai and mcp are leaves.
- Never log secrets or prompt bodies; secrets are `Redacted` from config to call site.
- Tests are `bun test` in `packages/<pkg>/test/`, no network, no real providers; sqlite tests may touch disk/`:memory:`; pg tests must skip unless `DATABASE_URL` is set.

## VCS
- jj colocated with git. Commit: `jj commit -m "type(scope): message"` (conventional commits, single line, no trailers).
