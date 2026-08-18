# @structure/cli

CLI command definitions on `@effect/cli` with the framework's config and observability pre-wired, and deterministic exit codes derived from the error taxonomy.

## Usage

```ts
import { defineCommand, Options, runCli, standardOptions } from "@structure/cli";
import { Effect } from "effect";

const migrate = defineCommand({
  name: "migrate",
  description: "Run pending migrations",
  options: { dryRun: Options.boolean("dry-run") },
  handler: ({ dryRun }) => Effect.log(`migrating (dryRun=${dryRun})`),
});

runCli({ name: "billing", version: "1.0.0", root: migrate, serviceName: "billing-cli" });
```

## Exports

| Export | What it is |
| --- | --- |
| `defineCommand({ name, description?, options?, args?, handler })` | Typed sugar over `Command.make`; handler receives the parsed values. Drop to raw `@effect/cli` for advanced layouts. |
| `Command` / `Options` / `Args` / `withSubcommands` | Re-exports of `@effect/cli` primitives (schema-typed options via `Options.withSchema`). |
| `standardOptions` / `allStandardOptions` / `standardLayers(values, service)` | `--log-level` (delegates to `@effect/cli`'s built-in, surfaced as a typed `LogLevel` value), `--log-format` (json\|pretty), `--config-file`; `standardLayers` turns them into an Observability layer + config `LoadOptions`. |
| `runCli({ name, version, root, serviceName? })` | Bun entrypoint: provides `BunContext`, maps failures to exit codes. |
| `runCliForTest(root, argv)` | Testable runner returning `{ exitCode, errorMessage, cause }` without touching `process.exit`. |
| `exitCodeFor(errorOrCause)` | The mapping: success 0 · usage errors 64 · `ConfigLoadError` 78 (all issues printed) · transient 75 · permanent/conflict 1 · defects 70 · interrupt 130. |
