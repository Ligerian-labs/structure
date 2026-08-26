---
name: create-cli-command
description: Define a typed CLI command with classified exit codes in a @structure-based app. Use when adding a CLI entrypoint, operator command, or wiring a migrations command group.
---

# Create a CLI command

Typed commands on `@effect/cli` with config and observability pre-wired, and deterministic exit codes derived from the error taxonomy. Reference: `packages/cli/README.md`.

## Steps

1. **Define the command** — handler receives parsed, typed values:

```ts
import { defineCommand, Options } from "@structure-ai/cli";
import { Effect } from "effect";

export const migrate = defineCommand({
  name: "migrate",
  description: "Run pending migrations",
  options: { dryRun: Options.boolean("dry-run") },
  handler: ({ dryRun }) => runMigrations({ dryRun }),
});
```

2. **Compose**: `withSubcommands` for command trees (e.g. a root with `migrate`, `serve`, `rebuild`); drop to raw `@effect/cli` primitives (re-exported) for advanced layouts.
3. **Standard options come free**: `--log-level`, `--log-format`, `--config-file` (`standardOptions`); `standardLayers(values, service)` turns them into an Observability layer + config load options.
4. **Mount pre-built groups** instead of reimplementing operators' CLIs: `migrationsCommand(set)` from `@structure-ai/migrations/cli` gives `<app> migrations up|status`.
5. **Run**: `runCli({ name, version, root, serviceName })` — the Bun entrypoint mapping failures to exit codes.
6. **Tests:** `runCliForTest(root, argv)` returns `{ exitCode, errorMessage, cause }` without touching `process.exit`; `exitCodeFor(error)` asserts the mapping directly. Follow `packages/cli/test/cli.test.ts`.

## Rules

- Exit codes are part of the contract: success 0 · usage 64 · `ConfigLoadError` 78 (all issues printed) · transient 75 · permanent/conflict 1 · defects 70 · interrupt 130. Don't `process.exit` from handlers; fail with a classified error instead.
- Operator commands print actionable output (what ran, what's pending), not raw dumps; `migrations status` shows `{ applied, pending }`.
- Long-running work gets a timeout and clean interrupt handling (130), not a kill.
- One concern per command; shared logic lives in the app's services, not the CLI layer.

## Verify

`bun x tsc --noEmit && bun test` in the package.
