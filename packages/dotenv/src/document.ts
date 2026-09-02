import { DotenvError } from "./errors.js";

/** How a value was quoted in the source file. Single quotes make a value literal (never expanded). */
export type QuoteStyle = "none" | "single" | "double" | "backtick";

/** One `KEY=value` line (or multi-line quoted value) as found in the file. */
export interface Assignment {
  readonly kind: "assignment";
  readonly key: string;
  /** The decoded value with dotenv semantics applied (quotes stripped, `\n` expanded inside double quotes). */
  readonly value: string;
  readonly quote: QuoteStyle;
  /** Whether the line carried an `export ` prefix. */
  readonly exported: boolean;
  /** 1-based line of the key in the source. */
  readonly line: number;
  /** Trailing inline comment, including its `#`, when the line had one. */
  readonly comment: string | undefined;
  /** The verbatim source text of the whole item, without its line terminator. */
  readonly text: string;
}

/** Any line that is not an assignment: blank lines, comments, malformed lines. Kept verbatim. */
export interface Other {
  readonly kind: "other";
  readonly line: number;
  readonly text: string;
}

export type Item = Assignment | Other;

/**
 * A parsed dotenv file that remembers everything needed to write it back
 * unchanged: comments, blank lines, ordering, `export` prefixes, line endings.
 */
export interface Document {
  readonly items: ReadonlyArray<Item>;
  readonly eol: "\n" | "\r\n";
  readonly trailingNewline: boolean;
}

const KEY_LINE = /^(\s*)(export\s+)?([\w.-]+)(\s*=\s*|:\s+)/;
const QUOTE_CHARS: ReadonlySet<string> = new Set(['"', "'", "`"]);
const QUOTE_STYLE: Readonly<Record<string, QuoteStyle>> = {
  '"': "double",
  "'": "single",
  "`": "backtick",
};

/**
 * dotenv's value post-processing: trim, strip one pair of matching outer
 * quotes, and expand `\n` / `\r` escapes when the original was double-quoted.
 */
const decodeValue = (raw: string): { readonly value: string; readonly quote: QuoteStyle } => {
  const trimmed = raw.trim();
  const first = trimmed[0];
  const match = /^(['"`])([\s\S]*)\1$/.exec(trimmed);
  let value = match?.[2] ?? trimmed;
  const quote: QuoteStyle = match === null ? "none" : (QUOTE_STYLE[match[1] ?? ""] ?? "none");
  if (first === '"') {
    value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
  }
  return { value, quote };
};

/** Finds the closing quote for a value opened at `lines[startLine][startCol]`, skipping backslash-escaped quotes. */
const findClosingQuote = (
  lines: ReadonlyArray<string>,
  quote: string,
  startLine: number,
  startCol: number,
): { readonly line: number; readonly col: number } | undefined => {
  let line = startLine;
  let col = startCol;
  while (line < lines.length) {
    const text = lines[line] ?? "";
    while (col < text.length) {
      const char = text[col];
      if (char === "\\" && text[col + 1] === quote) {
        col += 2;
        continue;
      }
      if (char === quote) return { line, col };
      col += 1;
    }
    line += 1;
    col = 0;
  }
  return undefined;
};

/**
 * Parses dotenv content into a document. Parsing follows the `dotenv`
 * package: keys match `[\w.-]+`, an optional `export ` prefix is dropped,
 * `=` or `: ` separate key and value, values may be wrapped in single,
 * double or backtick quotes (spanning lines), unquoted values end at the
 * first `#`, and malformed lines are kept but ignored. A UTF-8 BOM is
 * skipped. Parsing never fails.
 */
export const parse = (content: string): Document => {
  const withoutBom = content.startsWith("﻿") ? content.slice(1) : content;
  const eol: "\n" | "\r\n" = withoutBom.includes("\r\n") ? "\r\n" : "\n";
  const normalized = withoutBom.replace(/\r\n/g, "\n");
  const trailingNewline = normalized.endsWith("\n");
  const body = trailingNewline ? normalized.slice(0, -1) : normalized;
  const lines = body === "" ? [] : body.split("\n");
  const items: Array<Item> = [];
  let index = 0;
  while (index < lines.length) {
    const text = lines[index] ?? "";
    const head = KEY_LINE.exec(text);
    if (head === null) {
      items.push({ kind: "other", line: index + 1, text });
      index += 1;
      continue;
    }
    const key = head[3] ?? "";
    const exported = head[2] !== undefined;
    const prefixLength = head[0].length;
    const rest = text.slice(prefixLength);
    const opening = rest[0];
    if (opening !== undefined && QUOTE_CHARS.has(opening)) {
      const closing = findClosingQuote(lines, opening, index, prefixLength + 1);
      if (closing !== undefined) {
        const closingText = lines[closing.line] ?? "";
        const after = closingText.slice(closing.col + 1);
        if (/^\s*(#.*)?$/.test(after)) {
          const raw =
            closing.line === index
              ? rest.slice(0, closing.col + 1 - prefixLength)
              : [
                  rest,
                  ...lines.slice(index + 1, closing.line),
                  closingText.slice(0, closing.col + 1),
                ].join("\n");
          const decoded = decodeValue(raw);
          const comment = after.trim();
          items.push({
            kind: "assignment",
            key,
            value: decoded.value,
            quote: decoded.quote,
            exported,
            line: index + 1,
            comment: comment === "" ? undefined : comment,
            text: lines.slice(index, closing.line + 1).join("\n"),
          });
          index = closing.line + 1;
          continue;
        }
      }
    }
    const hash = rest.indexOf("#");
    const raw = hash === -1 ? rest : rest.slice(0, hash);
    const commentText = hash === -1 ? undefined : rest.slice(hash);
    const keepComment = commentText !== undefined && (hash === 0 || /\s$/.test(raw));
    const decoded = decodeValue(raw);
    items.push({
      kind: "assignment",
      key,
      value: decoded.value,
      quote: decoded.quote,
      exported,
      line: index + 1,
      comment: keepComment ? commentText : undefined,
      text,
    });
    index += 1;
  }
  return { items, eol, trailingNewline };
};

/** The assignments of a document, in source order (duplicates included). */
export const assignments = (document: Document): ReadonlyArray<Assignment> =>
  document.items.filter((item): item is Assignment => item.kind === "assignment");

/** The values of a document as a map; a repeated key keeps its last value, like `dotenv`. */
export const values = (document: Document): Map<string, string> => {
  const out = new Map<string, string>();
  for (const item of assignments(document)) out.set(item.key, item.value);
  return out;
};

/** Writes the document back; an untouched document renders byte-identical to its source (BOM aside). */
export const render = (document: Document): string => {
  const body = document.items.map((item) => item.text).join(document.eol);
  return document.trailingNewline ? `${body}${document.eol}` : body;
};

const BARE_VALUE = /^[^\s#'"`\\$]+$/;
const DOUBLE_UNSAFE = /\\[nr$]/;

/**
 * Formats a value so that {@link parse} reads it back unchanged. Prefers a
 * bare value, then single quotes (literal, so `$` is safe), then double
 * quotes and backticks with `$` escaped. Fails when the value contains all
 * three quote characters, which no dotenv quoting can represent.
 */
export const formatValue = (value: string): string => {
  if (value === "") return "";
  if (BARE_VALUE.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  const escaped = value.replace(/\$/g, "\\$");
  if (!value.includes('"') && !DOUBLE_UNSAFE.test(value)) return `"${escaped}"`;
  if (!value.includes("`") && !DOUBLE_UNSAFE.test(value)) return `\`${escaped}\``;
  throw new DotenvError({
    kind: "write",
    reason: "value cannot be quoted losslessly (it mixes single, double and backtick quotes)",
  });
};

const renderAssignment = (
  key: string,
  value: string,
  exported: boolean,
  comment: string | undefined,
): string =>
  `${exported ? "export " : ""}${key}=${formatValue(value)}${comment === undefined ? "" : ` ${comment}`}`;

/**
 * Sets `key` to `value`, rewriting the last existing assignment in place
 * (keeping its `export` prefix and inline comment) or appending a new line.
 * Every other byte of the document is preserved.
 */
export const set = (document: Document, key: string, value: string): Document => {
  let target = -1;
  document.items.forEach((item, index) => {
    if (item.kind === "assignment" && item.key === key) target = index;
  });
  if (target === -1) {
    const line = document.items.length + 1;
    return {
      ...document,
      items: [
        ...document.items,
        {
          kind: "assignment",
          key,
          value,
          quote: "none",
          exported: false,
          line,
          comment: undefined,
          text: renderAssignment(key, value, false, undefined),
        },
      ],
      trailingNewline: true,
    };
  }
  const items = document.items.map((item, index) => {
    if (index !== target || item.kind !== "assignment") return item;
    return {
      ...item,
      value,
      text: renderAssignment(key, value, item.exported, item.comment),
    };
  });
  return { ...document, items };
};

/** Removes every assignment of `key`; other lines are untouched. */
export const unset = (document: Document, key: string): Document => ({
  ...document,
  items: document.items.filter((item) => item.kind !== "assignment" || item.key !== key),
});

/** Serializes a value map as dotenv content, one `KEY=value` per line, quoting as needed. */
export const stringify = (
  entries: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
): string => {
  const pairs = entries instanceof Map ? [...entries.entries()] : Object.entries(entries);
  return pairs.map(([key, value]) => renderAssignment(key, value, false, undefined)).join("\n");
};
