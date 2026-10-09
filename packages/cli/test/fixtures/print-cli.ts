// Test fixture: a runCli process that prints more than a pipe buffer of JSON
// lines, alternating between the global `console.log` (what handler code
// writes) and the Effect `Console` service (what `@effect/cli` and Effect
// loggers write), like a fixtures receipt or a report command. Spawned as a
// subprocess by run.test.ts; not imported directly.

import { Console, Effect } from "effect";
import { defineCommand, runCli } from "../../src/index.js";

const LINES = Number.parseInt(process.env.PRINT_LINES ?? "256", 10);

const root = defineCommand({
  name: "print",
  description:
    "Prints PRINT_LINES JSON lines, half via global console.log, half via Console service",
  handler: () =>
    Effect.gen(function* () {
      for (let i = 0; i < LINES; i++) {
        const line = JSON.stringify({ i, data: "x".repeat(2030) });
        // Even lines take the global-console path, odd lines the service
        // path; both must arrive in full through a slow pipe.
        if (i % 2 === 0) console.log(line);
        else yield* Console.log(line);
      }
    }),
});

runCli({ name: "print", version: "0.0.0-test", root });
