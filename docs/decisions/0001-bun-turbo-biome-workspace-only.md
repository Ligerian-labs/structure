# ADR-0001: Bun workspaces + Turborepo + Biome, packages consumed as source

- Status: accepted
- Date: 2026-08-18

## Context

The framework is a monorepo of small packages meant to be imported selectively. A build/publish pipeline adds versioning, artifact, and dts-generation overhead before there are external consumers.

## Decision

Bun workspaces with isolated installs and a root `catalog` for shared dependency versions; Turborepo for `typecheck`/`test` task running; Biome as the single formatter/linter. Packages are private and consumed as TypeScript source (`exports` → `./src/index.ts`) via `workspace:*` — no build step.

## Consequences

- One place (root catalog) pins every `@effect/*` version; packages can't drift.
- Isolated installs force honest dependency declarations (undeclared deps simply don't resolve).
- Consumers must be TypeScript + bundler-resolution environments — acceptable while consumption is workspace-internal.
- Revisit when the first external (npm) consumer appears: that requires dist builds, dts, and changesets (tracked as a deliberate future step, not done implicitly).
