import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Effect } from "effect";
import * as Document from "./document.js";
import { DotenvError } from "./errors.js";

const readDocument = (path: string): Effect.Effect<Document.Document, DotenvError> =>
  Effect.try({
    try: () => Document.parse(existsSync(path) ? readFileSync(path, "utf8") : ""),
    catch: (cause) =>
      new DotenvError({ kind: "read", path, reason: `cannot read file: ${String(cause)}` }),
  });

const writeDocument = (
  path: string,
  document: Document.Document,
): Effect.Effect<void, DotenvError> =>
  Effect.try({
    try: () => writeFileSync(path, Document.render(document), "utf8"),
    catch: (cause) =>
      new DotenvError({ kind: "write", path, reason: `cannot write file: ${String(cause)}` }),
  });

const update = (
  path: string,
  change: (document: Document.Document) => Document.Document,
): Effect.Effect<void, DotenvError> =>
  Effect.gen(function* () {
    const document = yield* readDocument(path);
    const changed = yield* Effect.try({
      try: () => change(document),
      catch: (cause) =>
        cause instanceof DotenvError
          ? new DotenvError({ kind: cause.kind, path, reason: cause.reason })
          : new DotenvError({ kind: "write", path, reason: String(cause) }),
    });
    yield* writeDocument(path, changed);
  });

/**
 * Sets values in a dotenv file, creating it when absent. Existing lines are
 * rewritten in place; comments, ordering and other keys are preserved.
 */
export const setValues = (
  path: string,
  entries: Readonly<Record<string, string>>,
): Effect.Effect<void, DotenvError> =>
  update(path, (document) =>
    Object.entries(entries).reduce((doc, [key, value]) => Document.set(doc, key, value), document),
  );

/** Removes keys from a dotenv file; other lines are untouched. */
export const unsetKeys = (
  path: string,
  keys: ReadonlyArray<string>,
): Effect.Effect<void, DotenvError> =>
  update(path, (document) => keys.reduce((doc, key) => Document.unset(doc, key), document));
