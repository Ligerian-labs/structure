// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the strings under test are dotenv references, not templates
import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import { Document, DotenvError, expand } from "../src/index.js";

const run = (content: string, env: Record<string, string> = {}, override = false) =>
  Effect.runPromise(expand(Document.assignments(Document.parse(content)), { env, override }));

describe("expand (dotenv-expand syntax)", () => {
  test("$VAR and ${VAR} resolve from earlier keys in the file and from the environment", async () => {
    const values = await run("A=a\nB=$A-b\nC=${B}/${HOME_DIR}", { HOME_DIR: "/home" });
    expect(values.get("B")).toBe("a-b");
    expect(values.get("C")).toBe("a-b//home");
  });

  test("later keys are visible too (order-independent)", async () => {
    const values = await run("A=${B}!\nB=b");
    expect(values.get("A")).toBe("b!");
  });

  test("the environment wins over the file by default, the file wins with override", async () => {
    expect((await run("A=file\nB=$A", { A: "env" })).get("B")).toBe("env");
    expect((await run("A=file\nB=$A", { A: "env" }, true)).get("B")).toBe("file");
  });

  test("default and alternate operators", async () => {
    const values = await run(
      [
        "EMPTY=",
        "D1=${UNSET:-fallback}",
        "D2=${EMPTY:-fallback}",
        "D3=${EMPTY-fallback}",
        "D4=${UNSET-fallback}",
        "A1=${SET:+alt}",
        "A2=${EMPTY:+alt}",
        "A3=${EMPTY+alt}",
        "A4=${UNSET+alt}",
        "NESTED=${UNSET:-${SET}}",
      ].join("\n"),
      { SET: "yes" },
    );
    expect(values.get("D1")).toBe("fallback");
    expect(values.get("D2")).toBe("fallback");
    expect(values.get("D3")).toBe("");
    expect(values.get("D4")).toBe("fallback");
    expect(values.get("A1")).toBe("alt");
    expect(values.get("A2")).toBe("");
    expect(values.get("A3")).toBe("alt");
    expect(values.get("A4")).toBe("");
    expect(values.get("NESTED")).toBe("yes");
  });

  test("an undefined reference expands to the empty string", async () => {
    expect((await run("A=x${NOPE}y")).get("A")).toBe("xy");
  });

  test("\\$ is a literal dollar sign and single-quoted values never expand", async () => {
    const values = await run("A=a\nESC=\\${A}\nLIT='${A}'\nDBL=\"${A}\"\nBT=`$A`");
    expect(values.get("ESC")).toBe("${A}");
    expect(values.get("LIT")).toBe("${A}");
    expect(values.get("DBL")).toBe("a");
    expect(values.get("BT")).toBe("a");
  });

  test("a reference cycle fails with DotenvError(expand)", async () => {
    const exit = await Effect.runPromiseExit(
      expand(Document.assignments(Document.parse("A=${B}\nB=${A}"))),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(DotenvError);
      expect(exit.cause.error.kind).toBe("expand");
      expect(exit.cause.error.classification).toBe("permanent");
    }
  });

  test("a self reference resolves against the environment before it is a cycle", async () => {
    expect((await run("PATH=/extra:$PATH", { PATH: "/bin" })).get("PATH")).toBe("/extra:/bin");
  });
});
