import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Effect } from "effect";

/**
 * JSON Schema for the event envelope, matching `WireEvent`. Mount the
 * generated file in the broker's schema registry (`--schema-registry
 * file://<dir>` with one `<topic>.json` per topic) to get broker-side
 * rejection of malformed records; see the package README for wiring.
 */
export const envelopeJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://structure.dev/nisshi/event-envelope.json",
  title: "Event envelope",
  type: "object",
  required: ["type", "schemaVersion", "version", "payload", "metadata"],
  additionalProperties: false,
  properties: {
    type: { type: "string", minLength: 1 },
    schemaVersion: { type: "integer", minimum: 1 },
    version: { type: "integer", minimum: 1 },
    payload: {},
    metadata: {
      type: "object",
      required: ["occurredAt"],
      properties: {
        occurredAt: { type: "string", minLength: 1 },
      },
    },
  },
} as const;

/**
 * Writes one `<topic>.json` per topic into `dir` (created if missing).
 * Point the Nisshi broker at the directory to enforce the envelope
 * server-side.
 */
export const writeSchemaFiles = (dir: string, topics: ReadonlyArray<string>): Effect.Effect<void> =>
  Effect.forEach(topics, (topic) =>
    Effect.gen(function* () {
      const file = `${dir.replace(/\/$/, "")}/${topic}.json`;
      yield* Effect.promise(() => mkdir(dirname(file), { recursive: true }));
      yield* Effect.promise(() =>
        writeFile(file, `${JSON.stringify(envelopeJsonSchema, null, 2)}\n`, "utf8"),
      );
    }),
  ).pipe(Effect.asVoid);
