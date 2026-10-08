// Regression test for issue #101: `runCli` must not exit before a piped
// stdout drains. Spawns real child processes (allowed: local, no network).
// Children are generated inside this package's test tree (and removed
// afterwards) so they resolve `effect` and the CLI source to the same
// workspace copies as the package under test.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A payload comfortably larger than the 64 KiB kernel pipe capacity. */
const PAYLOAD_BYTES = 256 * 1024;
const TAIL = "END-SENTINEL";

const testRoot = join(import.meta.dir, "..", "draingen");
let dir: string;

beforeAll(() => {
  if (existsSync(testRoot)) rmSync(testRoot, { recursive: true, force: true });
  mkdirSync(testRoot, { recursive: true });
  dir = mkdtempSync(join(testRoot, "run-"));
});

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

/**
 * Runs a generated CLI entry through a deliberately slow pipe reader and
 * returns the child's exit code together with everything it managed to
 * deliver on stdout. The first chunk is delayed, so the 64 KiB kernel pipe
 * fills while the child still has bytes pending: anything the runtime leaves
 * queued at exit is lost, exactly like a slow `| cat` consumer downstream.
 */
const runThroughSlowPipe = async (entry: string): Promise<{ exitCode: number; stdout: string }> => {
  const proc = Bun.spawn(["bun", entry], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let out = "";
  let first = true;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
    if (first) {
      first = false;
      await Bun.sleep(50);
    }
  }
  const exitCode = await proc.exited;
  return { exitCode, stdout: out };
};

const payloadLiteral = (bytes: number): string =>
  JSON.stringify(JSON.stringify({ data: "x".repeat(bytes - 64), tail: TAIL }));

const writeCli = (name: string, body: ReadonlyArray<string>): string => {
  const entry = join(dir, `${name}.ts`);
  writeFileSync(entry, body.join("\n"));
  return entry;
};

describe("runCli piped stdout drain (issue #101)", () => {
  test("delivers a >64 KiB payload through a slow pipe", async () => {
    const entry = writeCli("emit-cli", [
      'import { defineCommand, runCli } from "../../src/index.js";',
      'import { Effect } from "effect";',
      `const payload = ${payloadLiteral(PAYLOAD_BYTES)};`,
      "const root = defineCommand({",
      '  name: "emit",',
      "  handler: () =>",
      "    Effect.sync(() => {",
      "      console.log(payload);",
      "    }),",
      "});",
      'runCli({ name: "emit-cli", version: "0.0.0-test", root });',
    ]);
    const { exitCode, stdout } = await runThroughSlowPipe(entry);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as { data: string; tail: string };
    expect(parsed.tail).toBe(TAIL);
    expect(parsed.data.length).toBe(PAYLOAD_BYTES - 64);
  }, 30_000);

  test("a failing handler still drains its stdout before exiting 1", async () => {
    const entry = writeCli("emit-fail-cli", [
      'import { defineCommand, runCli } from "../../src/index.js";',
      'import { Data, Effect } from "effect";',
      `const payload = ${payloadLiteral(PAYLOAD_BYTES)};`,
      'class Boom extends Data.TaggedError("Boom")<{ readonly classification: "permanent" }> {}',
      "const root = defineCommand({",
      '  name: "emit-fail",',
      "  handler: () =>",
      "    Effect.gen(function* () {",
      "      console.log(payload);",
      "      return yield* new Boom();",
      "    }),",
      "});",
      'runCli({ name: "emit-fail-cli", version: "0.0.0-test", root });',
    ]);
    const { exitCode, stdout } = await runThroughSlowPipe(entry);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout) as { data: string; tail: string };
    expect(parsed.tail).toBe(TAIL);
    expect(parsed.data.length).toBe(PAYLOAD_BYTES - 64);
  }, 30_000);
});
