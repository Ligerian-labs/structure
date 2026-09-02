import { describe, expect, test } from "bun:test";
import { Document, parse } from "../src/index.js";

// The `dotenv` package's own fixture (tests/.env), expected values as its test suite asserts them.
const fixture = `BASIC=basic

# previous line intentionally left blank
AFTER_LINE=after_line
EMPTY=
EMPTY_SINGLE_QUOTES=''
EMPTY_DOUBLE_QUOTES=""
EMPTY_BACKTICKS=\`\`
SINGLE_QUOTES='single_quotes'
SINGLE_QUOTES_SPACED='    single quotes    '
DOUBLE_QUOTES="double_quotes"
DOUBLE_QUOTES_SPACED="    double quotes    "
DOUBLE_QUOTES_INSIDE_SINGLE='double "quotes" work inside single quotes'
DOUBLE_QUOTES_WITH_NO_SPACE_BRACKET="{ port: $MONGOLAB_PORT}"
SINGLE_QUOTES_INSIDE_DOUBLE="single 'quotes' work inside double quotes"
BACKTICKS_INSIDE_SINGLE='\`backticks\` work inside single quotes'
BACKTICKS_INSIDE_DOUBLE="\`backticks\` work inside double quotes"
BACKTICKS=\`backticks\`
BACKTICKS_SPACED=\`    backticks    \`
DOUBLE_QUOTES_INSIDE_BACKTICKS=\`double "quotes" work inside backticks\`
SINGLE_QUOTES_INSIDE_BACKTICKS=\`single 'quotes' work inside backticks\`
DOUBLE_AND_SINGLE_QUOTES_INSIDE_BACKTICKS=\`double "quotes" and single 'quotes' work inside backticks\`
EXPAND_NEWLINES="expand\\nnew\\nlines"
DONT_EXPAND_UNQUOTED=dontexpand\\nnewlines
DONT_EXPAND_SQUOTED='dontexpand\\nnewlines'
# COMMENTS=work
INLINE_COMMENTS=inline comments # work #very #well
INLINE_COMMENTS_SINGLE_QUOTES='inline comments outside of #singlequotes' # work
INLINE_COMMENTS_DOUBLE_QUOTES="inline comments outside of #doublequotes" # work
INLINE_COMMENTS_BACKTICKS=\`inline comments outside of #backticks\` # work
INLINE_COMMENTS_SPACE=inline comments start with a#number sign. no space required.
EQUAL_SIGNS=equals==
RETAIN_INNER_QUOTES={"foo": "bar"}
RETAIN_INNER_QUOTES_AS_STRING='{"foo": "bar"}'
RETAIN_INNER_QUOTES_AS_BACKTICKS=\`{"foo": "bar's"}\`
TRIM_SPACE_FROM_UNQUOTED=    some spaced out string
USERNAME=therealnerdybeast@example.tld
SPACED_KEY = parsed
`;

const multiline = `BASIC=basic
MULTI_DOUBLE_QUOTED="THIS
IS
A
MULTILINE
STRING"
MULTI_SINGLE_QUOTED='THIS
IS
A
MULTILINE
STRING'
MULTI_BACKTICKED=\`THIS
IS
A
"MULTILINE'S"
STRING\`
MULTI_PEM_DOUBLE_QUOTED="-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCcU7+gX4B7EJYDs8rCLpF/+9BN
-----END PUBLIC KEY-----"
export EXPORT_EXAMPLE = ignore export
`;

describe("parse (dotenv compatibility)", () => {
  const values = parse(fixture);

  test.each([
    ["BASIC", "basic"],
    ["AFTER_LINE", "after_line"],
    ["EMPTY", ""],
    ["EMPTY_SINGLE_QUOTES", ""],
    ["EMPTY_DOUBLE_QUOTES", ""],
    ["EMPTY_BACKTICKS", ""],
    ["SINGLE_QUOTES", "single_quotes"],
    ["SINGLE_QUOTES_SPACED", "    single quotes    "],
    ["DOUBLE_QUOTES", "double_quotes"],
    ["DOUBLE_QUOTES_SPACED", "    double quotes    "],
    ["DOUBLE_QUOTES_INSIDE_SINGLE", 'double "quotes" work inside single quotes'],
    ["DOUBLE_QUOTES_WITH_NO_SPACE_BRACKET", "{ port: $MONGOLAB_PORT}"],
    ["SINGLE_QUOTES_INSIDE_DOUBLE", "single 'quotes' work inside double quotes"],
    ["BACKTICKS_INSIDE_SINGLE", "`backticks` work inside single quotes"],
    ["BACKTICKS_INSIDE_DOUBLE", "`backticks` work inside double quotes"],
    ["BACKTICKS", "backticks"],
    ["BACKTICKS_SPACED", "    backticks    "],
    ["DOUBLE_QUOTES_INSIDE_BACKTICKS", 'double "quotes" work inside backticks'],
    ["SINGLE_QUOTES_INSIDE_BACKTICKS", "single 'quotes' work inside backticks"],
    [
      "DOUBLE_AND_SINGLE_QUOTES_INSIDE_BACKTICKS",
      "double \"quotes\" and single 'quotes' work inside backticks",
    ],
    ["EXPAND_NEWLINES", "expand\nnew\nlines"],
    ["DONT_EXPAND_UNQUOTED", "dontexpand\\nnewlines"],
    ["DONT_EXPAND_SQUOTED", "dontexpand\\nnewlines"],
    ["INLINE_COMMENTS", "inline comments"],
    ["INLINE_COMMENTS_SINGLE_QUOTES", "inline comments outside of #singlequotes"],
    ["INLINE_COMMENTS_DOUBLE_QUOTES", "inline comments outside of #doublequotes"],
    ["INLINE_COMMENTS_BACKTICKS", "inline comments outside of #backticks"],
    ["INLINE_COMMENTS_SPACE", "inline comments start with a"],
    ["EQUAL_SIGNS", "equals=="],
    ["RETAIN_INNER_QUOTES", '{"foo": "bar"}'],
    ["RETAIN_INNER_QUOTES_AS_STRING", '{"foo": "bar"}'],
    ["RETAIN_INNER_QUOTES_AS_BACKTICKS", '{"foo": "bar\'s"}'],
    ["TRIM_SPACE_FROM_UNQUOTED", "some spaced out string"],
    ["USERNAME", "therealnerdybeast@example.tld"],
    ["SPACED_KEY", "parsed"],
  ])("%s", (key, expected) => {
    expect(values.get(key)).toBe(expected);
  });

  test("commented-out lines are not keys", () => {
    expect(values.has("COMMENTS")).toBe(false);
    expect(values.size).toBe(35);
  });

  test("multi-line quoted values", () => {
    const parsed = parse(multiline);
    expect(parsed.get("MULTI_DOUBLE_QUOTED")).toBe("THIS\nIS\nA\nMULTILINE\nSTRING");
    expect(parsed.get("MULTI_SINGLE_QUOTED")).toBe("THIS\nIS\nA\nMULTILINE\nSTRING");
    expect(parsed.get("MULTI_BACKTICKED")).toBe('THIS\nIS\nA\n"MULTILINE\'S"\nSTRING');
    expect(parsed.get("MULTI_PEM_DOUBLE_QUOTED")).toBe(
      "-----BEGIN PUBLIC KEY-----\nMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCcU7+gX4B7EJYDs8rCLpF/+9BN\n-----END PUBLIC KEY-----",
    );
    expect(parsed.get("EXPORT_EXAMPLE")).toBe("ignore export");
  });

  test("CRLF line endings, BOM, colon separator, and last-duplicate-wins", () => {
    const parsed = parse("\uFEFFA=1\r\nB: two\r\nA=3\r\n");
    expect(parsed.get("A")).toBe("3");
    expect(parsed.get("B")).toBe("two");
  });

  test("an unterminated quote falls back to an unquoted value", () => {
    expect(parse('KEY="unterminated\nNEXT=1').get("KEY")).toBe('"unterminated');
    expect(parse('KEY="unterminated\nNEXT=1').get("NEXT")).toBe("1");
  });

  test("a closing quote followed by text is not a quoted value", () => {
    expect(parse('KEY="a" b').get("KEY")).toBe('"a" b');
  });

  test("lines without a separator and invalid keys are ignored", () => {
    const parsed = parse("JUSTAKEY\n1NUMERIC=ok\nKEY WITH SPACE=no\nGOOD=yes");
    expect(parsed.size).toBe(2);
    expect(parsed.get("1NUMERIC")).toBe("ok");
    expect(parsed.get("GOOD")).toBe("yes");
  });

  test("the document keeps quote style, export prefix, comments and line numbers", () => {
    const doc = Document.parse("# head\nexport A='x' # note\nB=\"y\"\n");
    const [a, b] = Document.assignments(doc);
    expect(a).toMatchObject({
      key: "A",
      quote: "single",
      exported: true,
      comment: "# note",
      line: 2,
    });
    expect(b).toMatchObject({ key: "B", quote: "double", exported: false, line: 3 });
  });
});
