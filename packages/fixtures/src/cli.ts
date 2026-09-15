import { Args, defineCommand, Options, withSubcommands } from "@structure-ai/cli";
import { Console, Effect } from "effect";
import { type Catalog, cleanup, FixtureError, plan, type RunReport, run } from "./index.js";

export interface FixturesCommandOptions<E, R> {
  /** Resolve from app configuration. No CLI flag can grant this capability. */
  readonly enabled?: boolean;
  readonly ready: (
    report: RunReport<Readonly<Record<string, unknown>>>,
  ) => Effect.Effect<void, E, R>;
  /** Commands scoped to this run ID. Omit when the app has no supported removal workflow. */
  readonly cleanup?: (runId: string) => Effect.Effect<void, E, R>;
  readonly timeoutMs?: number;
}

const decodeJson = (input: string) =>
  Effect.try({
    try: (): unknown => JSON.parse(input),
    catch: () =>
      new FixtureError({
        reason: "input",
        detail: "--input must contain valid JSON",
        classification: "permanent",
      }),
  });

/** Mount `<app> fixtures list|plan|load|cleanup`. stdout is JSON; progress receipts go to stderr. */
export const fixturesCommand = <CR, E, R>(
  catalog: Catalog<CR>,
  options: FixturesCommandOptions<E, R>,
) => {
  const select = {
    args: { scenario: Args.text({ name: "scenario" }) },
    options: { input: Options.text("input").pipe(Options.withDefault("{}")) },
  };
  const list = defineCommand({
    name: "list",
    description: "List named fixture scenarios",
    handler: () => catalog.list.pipe(Effect.flatMap((value) => Console.log(JSON.stringify(value)))),
  });
  const planned = defineCommand({
    name: "plan",
    description: "Validate inputs and show dependency order without writing data",
    ...select,
    handler: ({ scenario, input }) =>
      Effect.gen(function* () {
        const fixtures = yield* catalog.prepare(scenario, yield* decodeJson(input));
        const keys = yield* plan(fixtures);
        yield* Console.log(JSON.stringify({ scenario, fixtures: keys }));
      }),
  });
  const load = defineCommand({
    name: "load",
    description: "Create base and feature data in a new isolated run",
    ...select,
    handler: ({ scenario, input }) =>
      Effect.gen(function* () {
        const fixtures = yield* catalog.prepare(scenario, yield* decodeJson(input));
        const report = yield* run({
          fixtures,
          ready: options.ready,
          ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          onProgress: (progress) =>
            Console.error(JSON.stringify({ event: "fixtures.progress", ...progress })),
        });
        // Fixture outputs may contain personal data or secrets. Print only generated IDs.
        yield* Console.log(
          JSON.stringify({
            scenario,
            runId: report.runId,
            completed: report.completed,
            ids: report.ids,
          }),
        );
      }),
  });
  const remove = defineCommand({
    name: "cleanup",
    description: "Run the application's cleanup commands for one fixture run",
    args: { runId: Args.text({ name: "run-id" }) },
    handler: ({ runId }) =>
      Effect.gen(function* () {
        const hook = options.cleanup;
        if (hook === undefined)
          return yield* new FixtureError({
            reason: "cleanup",
            detail: "This application has no fixture cleanup hook",
            classification: "permanent",
          });
        yield* cleanup({
          runId,
          remove: hook,
          ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        });
        yield* Console.log(JSON.stringify({ runId, cleaned: true }));
      }),
  });
  return withSubcommands(
    defineCommand({
      name: "fixtures",
      description: "Compose data for development, tests and previews",
      handler: () => Console.log("use a subcommand: list | plan | load | cleanup"),
    }),
    [list, planned, load, remove],
  );
};
