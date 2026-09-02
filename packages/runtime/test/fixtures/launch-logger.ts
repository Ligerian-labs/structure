// Launched as a subprocess by runtime.test.ts: one log record through
// `launch`, with the observability logger chosen by argv[2] ("json" | "pretty").
import * as Observability from "@structure-ai/observability";
import { Effect } from "effect";
import { launch } from "../../src/index.js";

const logFormat = process.argv[2] === "pretty" ? "pretty" : "json";

launch(Effect.log("launched"), {
  layers: Observability.layer({ service: { name: "fixture", version: "0.0.0" }, logFormat }),
});
