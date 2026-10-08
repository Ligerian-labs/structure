import { writeSync } from "node:fs";

/**
 * Synchronous stdio drain for Bun CLI processes (issue #101).
 *
 * When `BunRuntime.runMain`'s keepalive interval is cleared after the root
 * effect completes, the process can exit while Bun's piped stdout still has
 * non-blocking writes queued: bytes past the 64 KiB kernel pipe capacity are
 * silently dropped, so `myapp emit | jq` reads truncated JSON. Bun flushes
 * plain scripts before natural exit, but the keepalive-held runtime path
 * does not get that flush.
 *
 * Replacing `process.stdout.write`/`process.stderr.write` with blocking
 * `fs.writeSync` loops (retrying `EAGAIN`, stopping silently on `EPIPE`,
 * matching the downstream workaround this replaces) makes every later
 * write — including the global console's — block until the kernel has the
 * bytes, so nothing can be queued and lost at exit. A fresh `console.Console`
 * built over the patched streams keeps Bun's native formatting for objects.
 *
 * The patch is process-global by design: a CLI entrypoint calls it once from
 * `runCli`, before any handler runs.
 */

const encoder = new TextEncoder();

interface PatchableWrite {
  write(chunk: string | Uint8Array): boolean;
}

const isErrnoWithCode = (error: unknown): error is { readonly code: string } => {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string";
};

const writeAllSync = (fd: number, chunk: string | Uint8Array): boolean => {
  const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
  let offset = 0;
  while (offset < bytes.length) {
    try {
      offset += writeSync(fd, bytes, offset, bytes.length - offset);
    } catch (error) {
      if (!isErrnoWithCode(error)) throw error;
      // Non-blocking fd is full: retry until the reader drains it.
      if (error.code === "EAGAIN") continue;
      // Reader closed the pipe (`| head`): stop silently, like the shell.
      if (error.code === "EPIPE") return false;
      throw error;
    }
  }
  return true;
};

const patchStream = (stream: PatchableWrite, fd: number): void => {
  stream.write = (chunk: string | Uint8Array): boolean => writeAllSync(fd, chunk);
};

interface ConsoleConstructor {
  new (options: { readonly stdout: unknown; readonly stderr: unknown }): Console;
}

/**
 * Routes stdout and stderr of this process through blocking `writeSync`
 * loops so a piped consumer always receives every byte the command printed,
 * then rebuilds the global console over the patched streams to keep Bun's
 * native console formatting. Called once by {@link runCli} before the root
 * command runs; safe to call again (idempotent patching).
 */
export const installSyncStdio = (): void => {
  patchStream(process.stdout as unknown as PatchableWrite, process.stdout.fd);
  patchStream(process.stderr as unknown as PatchableWrite, process.stderr.fd);
  const ConsoleConstructor = (console as unknown as { readonly Console: ConsoleConstructor })
    .Console;
  globalThis.console = new ConsoleConstructor({
    stdout: process.stdout,
    stderr: process.stderr,
  });
};
