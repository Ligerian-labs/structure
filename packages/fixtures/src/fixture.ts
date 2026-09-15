import { createHash, randomUUID } from "node:crypto";
import { CommandBus, type CommandBusService } from "@structure-ai/cqrs";
import { Cause, Data, Effect, Option } from "effect";

/** Failure metadata never includes fixture inputs or command payloads in its message. */
export class FixtureError extends Data.TaggedError("FixtureError")<{
  readonly reason: "disabled" | "definition" | "input" | "execution" | "timeout" | "cleanup";
  readonly detail: string;
  readonly runId?: string;
  readonly completed?: ReadonlyArray<string>;
  readonly step?: string;
  /** Preserved for programmatic diagnosis; do not print without redaction. */
  readonly cause?: unknown;
  readonly classification: "permanent" | "transient" | "conflict";
}> {
  override get message(): string {
    return `${this.detail}${this.runId === undefined ? "" : ` (run ${this.runId}, step ${this.step ?? "unknown"}, completed: ${(this.completed ?? []).join(", ") || "none"})`}`;
  }
}

export interface FixtureContext {
  readonly runId: string;
  readonly key: string;
  /** Stable UUID for this label within this instance and run. Use for IDs and unique keys. */
  readonly id: (label: string) => string;
  /** The application's real bus, including its authorization and validation. */
  readonly dispatch: CommandBusService["dispatch"];
}

/** An explicitly shared instance. Construct a second instance with a different key for new data. */
export interface Fixture<A, E = never, R = never> {
  readonly key: string;
  readonly dependencies: Fixtures;
  /** Internal execution boundary; use run rather than invoking create directly. */
  readonly create: (
    context: FixtureContext,
    values: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<A, E, R>;
}

export type Fixtures = Readonly<Record<string, Fixture<unknown, unknown, unknown>>>;
export type Values<F extends Fixtures> = {
  readonly [K in keyof F]: F[K] extends Fixture<infer A, unknown, unknown> ? A : never;
};
export type Requirements<F extends Fixtures> = {
  [K in keyof F]: F[K] extends Fixture<unknown, unknown, infer R> ? R : never;
}[keyof F];
export type Errors<F extends Fixtures> = {
  [K in keyof F]: F[K] extends Fixture<unknown, infer E, unknown> ? E : never;
}[keyof F];

/**
 * Define one named instance. Use ordinary typed factory functions for defaults and overrides.
 * Dependencies execute first and their typed outputs are passed to create.
 */
export const defineFixture = <
  A,
  E,
  R,
  const D extends Fixtures = Record<never, never>,
>(definition: {
  readonly key: string;
  readonly dependencies?: D;
  readonly create: (
    context: FixtureContext & { readonly dependencies: Values<D> },
  ) => Effect.Effect<A, E, R>;
}): Fixture<A, E | Errors<D>, R | Requirements<D>> =>
  Object.freeze({
    key: definition.key,
    dependencies: Object.freeze({ ...definition.dependencies }),
    // The executor obtains every value from the corresponding dependency's create effect.
    create: (context: FixtureContext, values: Readonly<Record<string, unknown>>) =>
      definition.create({ ...context, dependencies: values as Values<D> }),
  });

const invalid = (detail: string) =>
  new FixtureError({ reason: "definition", detail, classification: "permanent" });
const keyPattern = /^[a-zA-Z0-9][a-zA-Z0-9/_-]{0,127}$/;

const rootOrder = Symbol("fixtureRootOrder");
type OrderedFixtures = Fixtures & {
  readonly [rootOrder]?: ReadonlyArray<Fixture<unknown, unknown, unknown>>;
};

/** Internal catalog composition: preserve base-first order even for integer-like root aliases. */
export const mergeRoots = (base: Fixtures, selected: Fixtures): Fixtures =>
  Object.freeze(
    Object.defineProperty({ ...base, ...selected }, rootOrder, {
      value: [...Object.values(base), ...Object.values(selected)],
    }),
  );

/** Resolve the entire graph before executing anything, including detecting duplicate definitions. */
const ordered = (
  fixtures: Fixtures,
): Effect.Effect<ReadonlyArray<Fixture<unknown, unknown, unknown>>, FixtureError> =>
  Effect.try({
    try: () => {
      const seen = new Map<string, Fixture<unknown, unknown, unknown>>();
      const visiting = new Set<string>();
      const nodes: Array<Fixture<unknown, unknown, unknown>> = [];
      const visit = (node: Fixture<unknown, unknown, unknown>): void => {
        if (!keyPattern.test(node.key))
          throw invalid(
            "Fixture keys must use 1-128 letters, digits, /, _ or -, starting with a letter or digit",
          );
        const existing = seen.get(node.key);
        if (existing !== undefined && existing !== node)
          throw invalid(
            `Conflicting fixture definitions for ${node.key}; share one object or choose distinct keys`,
          );
        if (visiting.has(node.key)) throw invalid(`Fixture dependency cycle at ${node.key}`);
        if (existing !== undefined) return;
        seen.set(node.key, node);
        visiting.add(node.key);
        for (const dependency of Object.values(node.dependencies)) visit(dependency);
        visiting.delete(node.key);
        nodes.push(node);
      };
      for (const fixture of (fixtures as OrderedFixtures)[rootOrder] ?? Object.values(fixtures))
        visit(fixture);
      return nodes;
    },
    catch: (cause) => (cause instanceof FixtureError ? cause : invalid("Invalid fixture graph")),
  });

/** Dependency order, deduplicated by explicit instance identity. Does not require permission or a bus. */
export const plan = (fixtures: Fixtures): Effect.Effect<ReadonlyArray<string>, FixtureError> =>
  Effect.map(ordered(fixtures), (nodes) => nodes.map((node) => node.key));

export interface RunProgress {
  readonly runId: string;
  readonly completed: ReadonlyArray<string>;
  readonly step: string;
}
export interface RunReport<A> {
  readonly runId: string;
  readonly completed: ReadonlyArray<string>;
  readonly values: A;
  /** Only IDs requested through context.id; safe metadata for the CLI, never raw fixture outputs. */
  readonly ids: Readonly<Record<string, Readonly<Record<string, string>>>>;
}
export interface RunOptions<F extends Fixtures, E, R> {
  readonly fixtures: F;
  /** App-owned capability, false by default. Never enable against production resources. */
  readonly enabled?: boolean;
  /** Drain owned work and/or assert query visibility. Pass Effect.void only for synchronous apps. */
  readonly ready: (report: RunReport<Values<F>>) => Effect.Effect<void, E, R>;
  /** Whole run deadline, including readiness; default 30,000 ms. No automatic retries. */
  readonly timeoutMs?: number;
  readonly onProgress?: (progress: RunProgress) => Effect.Effect<void>;
}

const checkAccess = (enabled: boolean | undefined): Effect.Effect<void, FixtureError> =>
  enabled === true
    ? Effect.void
    : Effect.fail(
        new FixtureError({
          reason: "disabled",
          detail: "Fixtures are disabled for this application target",
          classification: "permanent",
        }),
      );
const checkTimeout = (timeoutMs: number): Effect.Effect<void, FixtureError> =>
  Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Effect.void
    : Effect.fail(invalid("timeoutMs must be a finite positive number"));

const classification = (cause: Cause.Cause<unknown>): "permanent" | "transient" | "conflict" => {
  const failure = Cause.failureOption(cause);
  if (
    Option.isSome(failure) &&
    typeof failure.value === "object" &&
    failure.value !== null &&
    "classification" in failure.value
  ) {
    const value = failure.value.classification;
    if (value === "transient" || value === "conflict") return value;
  }
  return "permanent";
};

// UUIDv8: application-defined SHA-256 identity from an unambiguous tuple, with RFC variant bits.
const identity = (runId: string, key: string, label: string): string => {
  const hash = createHash("sha256")
    .update(JSON.stringify([runId, key, label]))
    .digest("hex");
  const variant = ((Number.parseInt(hash[16] ?? "0", 16) & 3) | 8).toString(16);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
};

/**
 * Create a fresh isolated run, sequentially. Completed data remains on success and failure.
 * The app must use generated IDs in commands and choose recording external adapters.
 * Failures retain their Cause and completion receipt. Interruption remains interruption.
 */
export const run = <const F extends Fixtures, E, R>(
  options: RunOptions<F, E, R>,
): Effect.Effect<RunReport<Values<F>>, FixtureError, CommandBus | Requirements<F> | R> =>
  Effect.gen(function* () {
    yield* checkAccess(options.enabled);
    const timeoutMs = options.timeoutMs ?? 30_000;
    yield* checkTimeout(timeoutMs);
    const nodes = yield* ordered(options.fixtures);
    const bus = yield* CommandBus;
    const runId = randomUUID();
    const completed: Array<string> = [];
    const values = new Map<string, unknown>();
    const ids = new Map<string, Map<string, string>>();
    let step = "start";
    const progress = () =>
      options.onProgress?.({ runId, completed: [...completed], step }) ?? Effect.void;
    const execute = Effect.gen(function* () {
      yield* progress();
      for (const node of nodes) {
        step = node.key;
        yield* progress();
        const nodeIds = new Map<string, string>();
        ids.set(node.key, nodeIds);
        const dependencies = Object.fromEntries(
          Object.entries(node.dependencies).map(([alias, dependency]) => [
            alias,
            values.get(dependency.key),
          ]),
        );
        // defineFixture includes all dependency requirements in F's R union. Traversal erases
        // heterogeneous output types, but never adds nodes outside that dependency graph.
        const value = yield* node.create(
          {
            runId,
            key: node.key,
            dispatch: bus.dispatch,
            id: (label) => {
              const value = identity(runId, node.key, label);
              nodeIds.set(label, value);
              return value;
            },
          },
          dependencies,
        ) as Effect.Effect<unknown, unknown, Requirements<F>>;
        values.set(node.key, value);
        completed.push(node.key);
      }
      const report: RunReport<Values<F>> = {
        runId,
        completed: [...completed],
        // Root aliases retain exactly their fixture's output type.
        values: Object.fromEntries(
          Object.entries(options.fixtures).map(([alias, node]) => [alias, values.get(node.key)]),
        ) as Values<F>,
        ids: Object.fromEntries([...ids].map(([key, labels]) => [key, Object.fromEntries(labels)])),
      };
      step = "ready";
      yield* progress();
      yield* options.ready(report);
      return report;
    }).pipe(
      Effect.timeoutFail({
        duration: timeoutMs,
        onTimeout: () =>
          new FixtureError({
            reason: "timeout",
            detail: "Fixture run timed out; partial data remains",
            classification: "transient",
          }),
      }),
    );
    return yield* execute.pipe(
      Effect.catchAllCause((cause) => {
        if (Cause.isInterruptedOnly(cause)) return Effect.failCause(cause as Cause.Cause<never>);
        const failure = Cause.failureOption(cause);
        const timedOut =
          Option.isSome(failure) &&
          failure.value instanceof FixtureError &&
          failure.value.reason === "timeout";
        return Effect.fail(
          new FixtureError({
            reason: timedOut ? "timeout" : "execution",
            detail: timedOut
              ? "Fixture run timed out; partial data remains"
              : "Fixture run failed; partial data remains",
            runId,
            completed: [...completed],
            step,
            cause,
            classification: classification(cause),
          }),
        );
      }),
    );
  });

/** Run only the app's cleanup commands for a specified run. No reset, SQL deletion or automatic cleanup. */
export const cleanup = <E, R>(options: {
  readonly runId: string;
  readonly enabled?: boolean;
  readonly remove: (runId: string) => Effect.Effect<void, E, R>;
  readonly timeoutMs?: number;
}): Effect.Effect<void, FixtureError, R> =>
  Effect.gen(function* () {
    yield* checkAccess(options.enabled);
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(options.runId)
    )
      return yield* invalid("Cleanup requires a fixture run UUID");
    const timeoutMs = options.timeoutMs ?? 30_000;
    yield* checkTimeout(timeoutMs);
    yield* Effect.suspend(() => options.remove(options.runId)).pipe(
      Effect.timeoutFail({
        duration: timeoutMs,
        onTimeout: () =>
          new FixtureError({
            reason: "timeout",
            detail: "Fixture cleanup timed out",
            classification: "transient",
          }),
      }),
      Effect.mapError(
        (cause) =>
          new FixtureError({
            reason: "cleanup",
            detail: "Fixture cleanup failed; inspect the run before retrying",
            runId: options.runId,
            step: "cleanup",
            cause,
            classification: classification(Cause.fail(cause)),
          }),
      ),
    );
  });
