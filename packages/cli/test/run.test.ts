import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

const fixture = new URL("./fixtures/print-cli.ts", import.meta.url).pathname;

/** Bytes one fixture line occupies on stdout (console.log appends `\n`). */
const lineBytes = (index: number): number =>
  JSON.stringify({ i: index, data: "x".repeat(2030) }).length + 1;

/**
 * Runs the fixture CLI with stdout as a pipe that is read slowly: the reader
 * consumes a few chunks, then stops reading for a while (leaving the pipe
 * full), then drains the rest. This is the `| jq` / `| cat` situation from
 * issue #101: a writer that only queues bytes asynchronously exits with the
 * pipe still full and the tail of its output is lost.
 */
const runThroughSlowPipe = (lines: number): Promise<readonly [number, number]> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", fixture],
    env: { ...process.env, PRINT_LINES: String(lines) },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  return Effect.promise(async () => {
    const received: Uint8Array[] = [];
    let total = 0;
    let pauses = 0;
    const reader = proc.stdout.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received.push(value);
      total += value.length;
      // Stop reading twice while the payload is in flight, holding the pipe
      // full for 250ms each time; a lossy writer exits during the pause.
      if (pauses < 2 && total > 12288) {
        pauses += 1;
        await Bun.sleep(250);
      }
    }
    const err = await new Response(proc.stderr).text();
    const code = await proc.exited;
    if (err.trim().length > 0) throw new Error(`fixture stderr: ${err.trim().slice(0, 400)}`);
    return [total, code] as const;
  }).pipe(Effect.runPromise) as Promise<readonly [number, number]>;
};

describe("runCli piped stdout", () => {
  test("delivers every byte of a >64KB payload through a slow pipe reader", async () => {
    const LINES = 256; // ≈512KB, well past the 64KB pipe buffer
    const expected = Array.from({ length: LINES }, (_, i) => lineBytes(i)).reduce(
      (a, b) => a + b,
      0,
    );
    const [received, code] = await runThroughSlowPipe(LINES);
    expect(code).toBe(0);
    expect(received).toBe(expected);
  }, 30_000);

  test("a payload that fits the pipe buffer arrives intact with exit code 0", async () => {
    const LINES = 4;
    const expected = Array.from({ length: LINES }, (_, i) => lineBytes(i)).reduce(
      (a, b) => a + b,
      0,
    );
    const [received, code] = await runThroughSlowPipe(LINES);
    expect(code).toBe(0);
    expect(received).toBe(expected);
  }, 30_000);
});
