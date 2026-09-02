import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ConfigIssue, Setting } from "@structure-ai/config";
import { Effect } from "effect";
import * as Document from "./document.js";
import { DotenvError } from "./errors.js";
import { environment, type LoadOptions, load } from "./load.js";

export interface CheckOptions extends LoadOptions {
  /** Settings definition: its required entries must be present, every entry is a known key. */
  readonly settings?: Setting<unknown>;
  /** Path (relative to `cwd`) of an example file whose keys are all required. */
  readonly example?: string;
  /** Accept an empty string as a present value (default `false`). */
  readonly allowEmpty?: boolean;
}

export interface CheckReport {
  /** Keys that must be present, from the settings definition and/or the example file. */
  readonly required: ReadonlyArray<string>;
  /** Required keys absent from both the environment and the files. */
  readonly missing: ReadonlyArray<string>;
  /** Required keys present with an empty value. */
  readonly empty: ReadonlyArray<string>;
  /** Keys the files define that neither the settings nor the example declare. */
  readonly unknown: ReadonlyArray<string>;
}

const exampleKeys = (path: string): Effect.Effect<ReadonlyArray<string>, DotenvError> =>
  Effect.gen(function* () {
    if (!existsSync(path)) {
      return yield* new DotenvError({ kind: "missing", path, reason: "example file not found" });
    }
    const content = yield* Effect.try({
      try: () => readFileSync(path, "utf8"),
      catch: (cause) =>
        new DotenvError({ kind: "read", path, reason: `cannot read file: ${String(cause)}` }),
    });
    return [...Document.values(Document.parse(content)).keys()];
  });

/**
 * Compares the effective environment (process environment merged with the
 * loaded files) against what the application declares. Required keys come
 * from settings without a default and from every key of the example file;
 * known keys from both. The report never carries values.
 */
export const check = (options: CheckOptions): Effect.Effect<CheckReport, DotenvError> =>
  Effect.gen(function* () {
    if (options.settings === undefined && options.example === undefined) {
      return yield* new DotenvError({
        kind: "invalid",
        reason: "check needs a settings definition or an example file",
      });
    }
    const required = new Set<string>();
    const known = new Set<string>();
    for (const doc of options.settings?.docs ?? []) {
      known.add(doc.name);
      if (doc.required) required.add(doc.name);
    }
    if (options.example !== undefined) {
      for (const key of yield* exampleKeys(
        resolve(options.cwd ?? process.cwd(), options.example),
      )) {
        known.add(key);
        required.add(key);
      }
    }
    const effective = yield* environment(options);
    const loaded = yield* load(options);
    const missing: Array<string> = [];
    const empty: Array<string> = [];
    for (const key of required) {
      const value = effective[key];
      if (value === undefined) missing.push(key);
      else if (value === "" && options.allowEmpty !== true) empty.push(key);
    }
    const unknown = [...loaded.sources.keys()].filter((key) => !known.has(key));
    return { required: [...required], missing, empty, unknown };
  });

/** Turns the failing part of a report into `ConfigLoadError` issues (one per key). */
export const toConfigIssues = (report: CheckReport): ReadonlyArray<ConfigIssue> => [
  ...report.missing.map((path) => ({
    kind: "missing" as const,
    path,
    reason: "required variable is not set",
  })),
  ...report.empty.map((path) => ({
    kind: "invalid" as const,
    path,
    reason: "required variable is empty",
  })),
];
