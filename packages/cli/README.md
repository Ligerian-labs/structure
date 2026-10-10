# @structure-ai/cli

CLI command definitions on `@effect/cli` with the framework's config and observability pre-wired, and deterministic exit codes derived from the error taxonomy.

## Usage

```ts
import { defineCommand, Options, runCli, standardOptions } from "@structure-ai/cli";
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
| `runCli({ name, version, root, serviceName? })` | Bun entrypoint: provides `BunContext`, maps failures to exit codes. Installs a blocking console (see below) so piped stdout never truncates. |
| `runCliForTest(root, argv)` | Testable runner returning `{ exitCode, errorMessage, cause }` without touching `process.exit`. |
| `exitCodeFor(errorOrCause)` | The mapping: success 0 · usage errors 64 · `ConfigLoadError` 78 (all issues printed) · transient 75 · permanent/conflict 1 · defects 70 · interrupt 130. |

For compound causes, interruption takes precedence, then defects, then typed failure classification. Diagnostics retain the compound cause. A tag-shaped object alone is not a `ConfigLoadError`.

## Blocking console (piped stdout)

On Bun, a piped stdout is non-blocking: `console.log` queues bytes and the
process may exit with the queue non-empty, silently truncating the tail of the
output (`| jq`, `| cat`, CI log collectors). `runCli` therefore installs a
process-wide blocking console as its first act: the global `console` and the
Effect `Console` service both write through `fs.writeSync` with `EAGAIN`
retry, waiting for a slow reader instead of losing bytes. `EPIPE` (e.g.
`| head -1`) ends the write silently — exit codes are unchanged.

`layerBlockingConsole` exports the same `Console` layer for entrypoints that
run commands outside `runCli` (custom runtimes, tests). Output through other
channels (`Bun.file().writer()`, manual `process.stdout.write`) is not
covered — write via the console, or use `writeBlocking` discipline yourself.
