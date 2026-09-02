import { Data } from "effect";

/**
 * What went wrong while working with dotenv files:
 * - `read`: a file exists but could not be read.
 * - `missing`: an explicitly requested file does not exist.
 * - `expand`: variable expansion hit a reference cycle.
 * - `write`: a value cannot be written losslessly, or the file cannot be written.
 * - `run`: a child process started by the CLI exited non-zero.
 * - `invalid`: the options given to an operation are contradictory or incomplete.
 */
export type DotenvErrorKind = "read" | "missing" | "expand" | "write" | "run" | "invalid";

/**
 * The single failure type of this package. Messages name files, keys and
 * exit codes — never values, which may be secrets.
 */
export class DotenvError extends Data.TaggedError("DotenvError")<{
  readonly kind: DotenvErrorKind;
  readonly reason: string;
  readonly path?: string;
  readonly key?: string;
  readonly exitCode?: number;
}> {
  readonly classification = "permanent" as const;

  override get message(): string {
    const where = this.path === undefined ? "" : ` (${this.path})`;
    return `[${this.kind}] ${this.reason}${where}`;
  }
}
