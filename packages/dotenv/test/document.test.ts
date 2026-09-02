import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Document, expand, formatValue, parse, stringify } from "../src/index.js";

const readBack = (content: string): string | undefined =>
  Effect.runSync(expand(Document.assignments(Document.parse(content)))).get("KEY");

describe("Document edits", () => {
  const source = "# database\nexport DB_URL='postgres://x' # local\n\nPORT=3000\nPORT=3001\n";

  test("an untouched document renders byte-identical", () => {
    expect(Document.render(Document.parse(source))).toBe(source);
    const crlf = "A=1\r\nB=2\r\n";
    expect(Document.render(Document.parse(crlf))).toBe(crlf);
    const noTrailing = "A=1\nB=2";
    expect(Document.render(Document.parse(noTrailing))).toBe(noTrailing);
  });

  test("set rewrites the last occurrence in place, keeping export prefix and comment", () => {
    const doc = Document.set(Document.parse(source), "DB_URL", "postgres://y");
    expect(Document.render(doc)).toBe(
      "# database\nexport DB_URL=postgres://y # local\n\nPORT=3000\nPORT=3001\n",
    );
    const ports = Document.set(Document.parse(source), "PORT", "4000");
    expect(Document.render(ports)).toContain("PORT=3000\nPORT=4000\n");
    expect(parse(Document.render(ports)).get("PORT")).toBe("4000");
  });

  test("set appends a missing key and ends the file with a newline", () => {
    expect(Document.render(Document.set(Document.parse("A=1"), "B", "two words"))).toBe(
      "A=1\nB='two words'\n",
    );
    expect(Document.render(Document.set(Document.parse(""), "A", "1"))).toBe("A=1\n");
  });

  test("unset removes every occurrence and nothing else", () => {
    expect(Document.render(Document.unset(Document.parse(source), "PORT"))).toBe(
      "# database\nexport DB_URL='postgres://x' # local\n\n",
    );
  });

  test("a multi-line value is replaced as one item", () => {
    const doc = Document.parse('KEY="line1\nline2"\nNEXT=1\n');
    expect(Document.render(Document.set(doc, "KEY", "flat"))).toBe("KEY=flat\nNEXT=1\n");
  });

  test.each([
    ["", ""],
    ["plain", "plain"],
    ["with space", "'with space'"],
    ["has#hash", "'has#hash'"],
    ["$notexpanded", "'$notexpanded'"],
    ["it's", '"it\'s"'],
    ["it's $5", '"it\'s \\$5"'],
    ['it\'s "quoted"', '`it\'s "quoted"`'],
    ["multi\nline", "'multi\nline'"],
    ["back\\slash", "'back\\slash'"],
  ])("formatValue(%j) round-trips through parse + expand", (value, formatted) => {
    expect(formatValue(value)).toBe(formatted);
    expect(readBack(`KEY=${formatted}`)).toBe(value);
  });

  test("a value mixing all three quote characters cannot be written losslessly", () => {
    expect(() => formatValue("'\"`")).toThrow("cannot be quoted losslessly");
  });

  test("stringify writes one quoted-as-needed line per entry", () => {
    expect(stringify({ A: "1", B: "two words", C: "" })).toBe("A=1\nB='two words'\nC=");
    expect(stringify(new Map([["X", "y"]]))).toBe("X=y");
  });
});
