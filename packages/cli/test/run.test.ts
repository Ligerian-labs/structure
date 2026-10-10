import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

const fixture = new URL("./fixtures/print-cli.ts", import.meta.url).pathname;

/** Bytes one fixture line occupies on stdout (console.log appends `\n`). */
const lineBytes = (index: number): number =>
  JSON.stringify({ i: index, data: "x".repeat(2030) }).length + 1;

/**
 * Runs the fixture CLI with stdout as a pipe that is read slowly. The reader
 * deliberately reads NOTHING for the first 1.2s — longer than the fixture
 * needs to print everything — so the 64 KiB kernel pipe fills while the
 * child still has ~448 KiB queued. A writer that only queues bytes
 * asynchronously (plain `console.log` under Bun) exits at that point and the
 * tail is lost; the reader then sees only what fit in the pipe. This is the
 * `| jq` / `| cat` situation from issue #101.
 */
const runThroughSlowPipe = (
  lines: number,
  fail: boolean,
): Promise<readonly [number, number, string]> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", fixture],
    env: { ...process.env, PRINT_LINES: String(lines), PRINT_FAIL: fail ? "1" : "0" },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  return Effect.promise(async () => {
    const received: Uint8Array[] = [];
    let total = 0;
    // Stall before the first read: pipe fills, lossy writers exit here.
    await Bun.sleep(1200);
    const reader = proc.stdout.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received.push(value);
      total += value.length;
    }
    const err = await new Response(proc.stderr).text();
    const code = await proc.exited;
    if (!fail && err.trim().length > 0) {
      throw new Error(`fixture stderr: ${err.trim().slice(0, 400)}`);
    }
    return [total, code, err] as const;
  }).pipe(Effect.runPromise) as Promise<readonly [number, number, string]>;
};

describe("runCli piped stdout", () => {
  test("delivers every byte of a >64KB payload through a slow pipe reader", async () => {
    const LINES = 256; // ≈512KB, well past the 64KB pipe buffer
    const expected = Array.from({ length: LINES }, (_, i) => lineBytes(i)).reduce(
      (a, b) => a + b,
      0,
    );
    const [received, code] = await runThroughSlowPipe(LINES, false);
    expect(code).toBe(0);
    expect(received).toBe(expected);
  }, 30_000);

  test("a failing handler still drains its stdout before exiting 1", async () => {
    const LINES = 256; // ≈512KB, well past the 64KB pipe buffer
    const expected = Array.from({ length: LINES }, (_, i) => lineBytes(i)).reduce(
      (a, b) => a + b,
      0,
    );
    const [received, code, err] = await runThroughSlowPipe(LINES, true);
    expect(code).toBe(1);
    expect(received).toBe(expected);
    // The failure line itself must also arrive through the (piped) stderr.
    expect(err).toContain("print:");
  }, 30_000);

  test("a payload that fits the pipe buffer arrives intact with exit code 0", async () => {
    const LINES = 4;
    const expected = Array.from({ length: LINES }, (_, i) => lineBytes(i)).reduce(
      (a, b) => a + b,
      0,
    );
    const [received, code] = await runThroughSlowPipe(LINES, false);
    expect(code).toBe(0);
    expect(received).toBe(expected);
  }, 30_000);
});
