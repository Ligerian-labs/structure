/**
 * Schema file generation. Broker-side enforcement (mounting the generated
 * files via `--schema-registry`) could NOT be verified against Nisshi
 * v0.7.0-pre.2: even Nisshi's own CLI accepts records that violate its own
 * sample schemas, so this suite only covers what we control — the generated
 * files and the client-side validation. Revisit when a Nisshi release
 * enforces INVALID_RECORD for JSON Schema topics.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { Effect } from "effect";
import { writeSchemaFiles } from "../src/index.js";

describe("nisshi schema files", () => {
  test("writeSchemaFiles writes one valid envelope schema per topic", async () => {
    const dir = `var/schema-unit-${crypto.randomUUID().slice(0, 8)}`;
    try {
      await Effect.runPromise(writeSchemaFiles(dir, ["events", "orders_events"]));
      for (const topic of ["events", "orders_events"]) {
        const file = `${dir}/${topic}.json`;
        expect(existsSync(file)).toBe(true);
        const parsed = JSON.parse(readFileSync(file, "utf8")) as {
          readonly type: string;
          readonly required: ReadonlyArray<string>;
        };
        expect(parsed.type).toBe("object");
        expect(parsed.required).toContain("type");
        expect(parsed.required).toContain("version");
        expect(parsed.required).toContain("metadata");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
