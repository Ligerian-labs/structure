import { Effect } from "effect";
import type { QuoteStyle } from "./document.js";
import { DotenvError } from "./errors.js";

/** A value awaiting expansion, with the quote style that decides whether it expands at all. */
export interface Expandable {
  readonly key: string;
  readonly value: string;
  readonly quote: QuoteStyle;
}

export interface ExpandOptions {
  /** Variables visible to `$VAR` references besides the entries themselves. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Which side wins when a referenced name exists both in `env` and among
   * the entries. `false` (default) resolves from `env` first — the same rule
   * the loader applies to the values themselves; `true` resolves from the
   * entries first.
   */
  readonly override?: boolean;
}

const REFERENCE =
  /\\\$|\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-+])((?:[^{}]|\{[^{}]*\})*))?\}|([A-Za-z_][A-Za-z0-9_]*))/g;

/**
 * Expands `$VAR`, `${VAR}`, `${VAR:-default}`, `${VAR-default}`,
 * `${VAR:+alternate}` and `${VAR+alternate}` references (the `dotenv-expand`
 * syntax) across a set of entries. `\$` is an escaped dollar sign.
 * Single-quoted values are literal and never expanded. An undefined name
 * expands to the empty string; a reference cycle fails with a `DotenvError`
 * of kind `expand`.
 */
export const expand = (
  entries: ReadonlyArray<Expandable>,
  options: ExpandOptions = {},
): Effect.Effect<Map<string, string>, DotenvError> =>
  Effect.suspend(() => {
    const env = options.env ?? {};
    const raw = new Map<string, Expandable>();
    for (const entry of entries) raw.set(entry.key, entry);
    const resolved = new Map<string, string>();
    const resolving = new Set<string>();

    const fromEntries = (name: string): string | undefined => {
      const entry = raw.get(name);
      if (entry === undefined) return undefined;
      const done = resolved.get(name);
      if (done !== undefined) return done;
      if (resolving.has(name)) {
        throw new DotenvError({
          kind: "expand",
          key: name,
          reason: `variable expansion cycle through ${name}`,
        });
      }
      resolving.add(name);
      const value = entry.quote === "single" ? entry.value : interpolate(entry.value);
      resolving.delete(name);
      resolved.set(name, value);
      return value;
    };

    const lookup = (name: string): string | undefined =>
      options.override === true
        ? (fromEntries(name) ?? env[name])
        : (env[name] ?? fromEntries(name));

    const interpolate = (text: string): string =>
      text.replace(
        REFERENCE,
        (match: string, braced?: string, operator?: string, fallback?: string, bare?: string) => {
          if (match === "\\$") return "$";
          const name = braced ?? bare ?? "";
          const value = lookup(name);
          const alternate = fallback ?? "";
          switch (operator) {
            case ":-":
              return value === undefined || value === "" ? interpolate(alternate) : value;
            case "-":
              return value === undefined ? interpolate(alternate) : value;
            case ":+":
              return value !== undefined && value !== "" ? interpolate(alternate) : "";
            case "+":
              return value !== undefined ? interpolate(alternate) : "";
            default:
              return value ?? "";
          }
        },
      );

    try {
      const out = new Map<string, string>();
      for (const entry of entries) out.set(entry.key, fromEntries(entry.key) ?? "");
      return Effect.succeed(out);
    } catch (error) {
      if (error instanceof DotenvError) return Effect.fail(error);
      throw error;
    }
  });
