import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXIT_CONFIG,
  EXIT_FAILURE,
  EXIT_SUCCESS,
  EXIT_USAGE,
  runCliForTest,
} from "@structure-ai/cli";
import { Settings } from "@structure-ai/config";
import { Effect } from "effect";
import { dotenvCommand } from "../src/cli.js";

let cwd = "";
const settings = Settings.struct({
  base: Settings.string("BASE"),
  token: Settings.secret("TOKEN"),
});

const captureStdout = async <A>(body: () => Promise<A>): Promise<{ result: A; output: string }> => {
  const original = console.log;
  const lines: Array<string> = [];
  console.log = (...args: Array<unknown>) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const result = await body();
    return { result, output: lines.join("\n") };
  } finally {
    console.log = original;
  }
};

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), "structure-dotenv-cli-"));
  await writeFile(join(cwd, ".env"), "BASE=b\nTOKEN=t0p-secret\nEXTRA=1\n");
  await writeFile(join(cwd, ".env.example"), "BASE=\nTOKEN=\nNEEDED=\n");
});

afterAll(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("dotenv CLI group", () => {
  test("check exits 78 with one issue per missing key and names unknown keys", async () => {
    const root = dotenvCommand({
      cwd,
      environment: "",
      env: {},
      settings,
      example: ".env.example",
    });
    const { result, output } = await captureStdout(() =>
      Effect.runPromise(runCliForTest(root, ["check"])),
    );
    expect(result.exitCode).toBe(EXIT_CONFIG);
    expect(result.errorMessage).toContain("NEEDED");
    expect(output).toContain("unknown  EXTRA");
    expect(output).toContain("missing  NEEDED");
    expect(output).not.toContain("t0p-secret");
  });

  test("check passes when everything is present", async () => {
    const root = dotenvCommand({ cwd, environment: "", env: { NEEDED: "x" }, settings });
    const { result } = await captureStdout(() =>
      Effect.runPromise(runCliForTest(root, ["check", "--example", ".env.example"])),
    );
    expect(result.exitCode).toBe(EXIT_SUCCESS);
  });

  test("print redacts values unless --reveal, and --json is machine readable", async () => {
    const root = dotenvCommand({ cwd, environment: "", env: { EXTRA: "env" } });
    const redacted = await captureStdout(() => Effect.runPromise(runCliForTest(root, ["print"])));
    expect(redacted.result.exitCode).toBe(EXIT_SUCCESS);
    expect(redacted.output).toContain("TOKEN=<redacted>");
    expect(redacted.output).toContain("# EXTRA kept from the environment");
    expect(redacted.output).not.toContain("t0p-secret");
    const revealed = await captureStdout(() =>
      Effect.runPromise(runCliForTest(root, ["print", "--reveal", "--json"])),
    );
    const parsed = JSON.parse(revealed.output) as {
      values: Record<string, string>;
      shadowed: Array<string>;
    };
    expect(parsed.values.TOKEN).toBe("t0p-secret");
    expect(parsed.shadowed).toEqual(["EXTRA"]);
  });

  test("run executes the command with the loaded environment and maps its exit code", async () => {
    const root = dotenvCommand({ cwd, environment: "", env: { PATH: process.env.PATH ?? "" } });
    const marker = join(cwd, "seen.txt");
    const script = `await Bun.write(${JSON.stringify(marker)}, process.env.BASE + ":" + process.env.TOKEN)`;
    const ok = await Effect.runPromise(runCliForTest(root, ["run", "--", "bun", "-e", script]));
    expect(ok.exitCode).toBe(EXIT_SUCCESS);
    expect(await Bun.file(marker).text()).toBe("b:t0p-secret");
    const failing = await Effect.runPromise(
      runCliForTest(root, ["run", "--", "bun", "-e", "process.exit(3)"]),
    );
    expect(failing.exitCode).toBe(EXIT_FAILURE);
    expect(failing.errorMessage).toContain("exited with code 3");
    const empty = await Effect.runPromise(runCliForTest(root, ["run"]));
    expect(empty.exitCode).toBe(EXIT_USAGE);
  });

  test("set and unset edit the file in place", async () => {
    const dir = await mkdtemp(join(tmpdir(), "structure-dotenv-cli-write-"));
    await writeFile(join(dir, ".env"), "# c\nA=1\n");
    const root = dotenvCommand({ cwd: dir, environment: "", env: {} });
    try {
      const set = await captureStdout(() =>
        Effect.runPromise(runCliForTest(root, ["set", "A", "new value"])),
      );
      expect(set.result.exitCode).toBe(EXIT_SUCCESS);
      await Effect.runPromise(runCliForTest(root, ["set", "B", "2", "--file", ".env"]));
      expect(await Bun.file(join(dir, ".env")).text()).toBe("# c\nA='new value'\nB=2\n");
      const unset = await Effect.runPromise(runCliForTest(root, ["unset", "A"]));
      expect(unset.exitCode).toBe(EXIT_SUCCESS);
      expect(await Bun.file(join(dir, ".env")).text()).toBe("# c\nB=2\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
