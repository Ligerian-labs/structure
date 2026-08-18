import { type ConfigError, Data } from "effect";
import * as CE from "effect/ConfigError";

/**
 * Raised when configuration loading fails at startup. Carries every issue
 * found (not only the first) so operators can fix all of them in one pass.
 */
export class ConfigLoadError extends Data.TaggedError("ConfigLoadError")<{
  readonly issues: ReadonlyArray<ConfigIssue>;
}> {
  override get message(): string {
    const lines = this.issues.map((i) => `  - [${i.kind}] ${i.path}: ${i.reason}`);
    return `Configuration is invalid (${this.issues.length} issue${
      this.issues.length === 1 ? "" : "s"
    }):\n${lines.join("\n")}`;
  }
}

export interface ConfigIssue {
  readonly kind: "missing" | "invalid" | "source" | "unsupported";
  readonly path: string;
  readonly reason: string;
}

/** Flattens the And/Or tree of a ConfigError into a list of issues. */
export const flattenConfigError = (error: ConfigError.ConfigError): ReadonlyArray<ConfigIssue> => {
  const issues: Array<ConfigIssue> = [];
  const walk = (e: ConfigError.ConfigError): void => {
    if (CE.isAnd(e) || CE.isOr(e)) {
      walk(e.left);
      walk(e.right);
      return;
    }
    if (CE.isMissingData(e)) {
      issues.push({ kind: "missing", path: e.path.join("."), reason: e.message });
      return;
    }
    if (CE.isInvalidData(e)) {
      issues.push({ kind: "invalid", path: e.path.join("."), reason: e.message });
      return;
    }
    if (CE.isSourceUnavailable(e)) {
      issues.push({ kind: "source", path: e.path.join("."), reason: e.message });
      return;
    }
    issues.push({
      kind: "unsupported",
      path: CE.isUnsupported(e) ? e.path.join(".") : "?",
      reason: e.message,
    });
  };
  walk(error);
  // An Or node means every source failed for the same key; one issue per key
  // and kind is enough for an operator to act on.
  const seen = new Set<string>();
  return issues.filter((i) => {
    const key = `${i.kind}:${i.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};
