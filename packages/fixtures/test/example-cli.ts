import { Command, defineCommand, runCli, withSubcommands } from "@structure-ai/cli";
import { Effect } from "effect";
import { fixturesCommand } from "../src/cli.js";
import { catalog, makeApp } from "./business-app.js";

// Demonstration only: these stores live for one process. A consuming app provides durable layers.
const app = makeApp();
const root = withSubcommands(defineCommand({ name: "shop", handler: () => Effect.void }), [
  fixturesCommand(catalog, { enabled: true, ready: () => app.ready, cleanup: app.cleanup }),
]).pipe(Command.provide(app.layer));

runCli({ name: "shop", version: "0.0.0", root });
