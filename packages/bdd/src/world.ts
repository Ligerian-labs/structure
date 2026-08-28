import {
  CommandBus,
  type CommandDefinition,
  type DispatchOptions,
  QueryBus,
  type QueryDefinition,
} from "@structure-ai/cqrs";
import { EventStore, type StoredEvent } from "@structure-ai/eventsourcing";
import { type Context, Effect, Exit, type Scope, Stream } from "effect";

/** Placeholder type surfaced when a world helper needs a service the app context does not provide. */
export interface WorldMissing<ServiceName extends string> {
  readonly __worldMissingService: ServiceName;
}

const hasTag = (error: unknown): error is { readonly _tag: string } =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  typeof (error as { _tag: unknown })._tag === "string";

/**
 * Per-scenario world: everything the step handlers of one scenario share.
 *
 * The app subclasses this with its own typed state (fixtures, last results,
 * doubles) and builds it in a {@link Scope} the suite owns — every scenario
 * starts from a fresh composition (in-memory stores, buses, doubles) and
 * tears it down afterwards. `R` is the app service union the world carries;
 * helpers below are available exactly when their service is in `R`.
 *
 * ```ts
 * class AppWorld extends ScenarioWorld<AppServices> {
 *   readonly mails: Array<OutgoingMail> = [];
 *   lastQuotation?: { readonly bookingId: string; readonly total: number };
 * }
 * ```
 */
/** Named principal of a scenario (registered by `Given` steps, dispatched as by `When` steps). */
export interface ScenarioActor {
  readonly name: string;
  readonly id: string;
}

export abstract class ScenarioWorld<R> {
  readonly scope: Scope.Scope;
  readonly #context: Context.Context<R>;

  /** Dispatch/query outcomes of the scenario, in order. */
  readonly outcomes: ReadonlyArray<Exit.Exit<unknown, unknown>> = [];

  readonly #actorMap = new Map<string, ScenarioActor>();
  #currentActor?: ScenarioActor;

  constructor(scope: Scope.Scope, context: Context.Context<R>) {
    this.scope = scope;
    this.#context = context;
  }

  /** Registers a principal and makes them the current actor. */
  readonly signIn = (name: string, id: string): void => {
    const actor: ScenarioActor = { name, id };
    this.#actorMap.set(name, actor);
    this.#currentActor = actor;
  };

  /** A previously registered principal by name, without switching to them. */
  readonly actorNamed = (name: string): ScenarioActor | undefined => this.#actorMap.get(name);

  /** The principal steps dispatch as ("the customer"); set by `signIn`. */
  get currentActor(): ScenarioActor | undefined {
    return this.#currentActor;
  }

  /** Runs an app effect with the world's services provided. */
  readonly use = <A, E>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, never> =>
    Effect.provide(effect, this.#context);

  readonly #record = <A, E>(exit: Exit.Exit<A, E>): Exit.Exit<A, E> => {
    (this.outcomes as Array<Exit.Exit<unknown, unknown>>).push(exit);
    return exit;
  };

  /**
   * Dispatches a command on the bus and captures the exit: successes are
   * available as `Exit.Success`, business and dispatch failures as
   * `Exit.Failure` — nothing throws, so a `Then` step can assert on the
   * expected failure afterwards. Requires `CommandBus` in the world context.
   */
  readonly dispatch = <
    Tag extends string,
    PayloadType,
    PayloadEncoded,
    SuccessType,
    SuccessEncoded,
    FailureType,
    FailureEncoded,
  >(
    definition: CommandDefinition<
      Tag,
      PayloadType,
      PayloadEncoded,
      SuccessType,
      SuccessEncoded,
      FailureType,
      FailureEncoded
    >,
    payload: PayloadEncoded,
    options?: Omit<DispatchOptions, "correlationId">,
  ): CommandBus extends R
    ? Effect.Effect<Exit.Exit<SuccessType, FailureType>, never, never>
    : WorldMissing<"CommandBus"> =>
    // The bus tag access requires `CommandBus`, which the conditional return
    // type already demands of R; the internal cast carries that guarantee.
    ((effect: Effect.Effect<unknown, unknown, CommandBus>) =>
      Effect.map(Effect.exit(this.use(effect as Effect.Effect<unknown, unknown, R>)), (exit) =>
        this.#record(exit),
      ))(
      Effect.flatMap(CommandBus, (bus) => bus.dispatch(definition, payload, options)),
    ) as CommandBus extends R
      ? Effect.Effect<Exit.Exit<SuccessType, FailureType>, never, never>
      : WorldMissing<"CommandBus">;

  /**
   * Dispatches a query and captures the exit, like {@link dispatch}.
   * Requires `QueryBus` in the world context.
   */
  readonly query = <
    Tag extends string,
    PayloadType,
    PayloadEncoded,
    SuccessType,
    SuccessEncoded,
    FailureType,
    FailureEncoded,
  >(
    definition: QueryDefinition<
      Tag,
      PayloadType,
      PayloadEncoded,
      SuccessType,
      SuccessEncoded,
      FailureType,
      FailureEncoded
    >,
    payload: PayloadEncoded,
    options?: Omit<DispatchOptions, "correlationId">,
  ): QueryBus extends R
    ? Effect.Effect<Exit.Exit<SuccessType, FailureType>, never, never>
    : WorldMissing<"QueryBus"> =>
    ((effect: Effect.Effect<unknown, unknown, QueryBus>) =>
      Effect.map(Effect.exit(this.use(effect as Effect.Effect<unknown, unknown, R>)), (exit) =>
        this.#record(exit),
      ))(
      Effect.flatMap(QueryBus, (bus) => bus.dispatch(definition, payload, options)),
    ) as QueryBus extends R
      ? Effect.Effect<Exit.Exit<SuccessType, FailureType>, never, never>
      : WorldMissing<"QueryBus">;

  /** The most recent dispatch/query outcome, if any. */
  get lastOutcome(): Exit.Exit<unknown, unknown> | undefined {
    return this.outcomes.at(-1);
  }

  /** `_tag`s of every recorded failure, in order. */
  readonly failureTags = (): ReadonlyArray<string> =>
    this.outcomes
      .filter((outcome): outcome is Exit.Failure<unknown, unknown> => Exit.isFailure(outcome))
      .map((outcome) => {
        const error = causeError(outcome);
        return hasTag(error) ? error._tag : "Unknown";
      });

  /** Throws (fails the scenario) unless the last outcome succeeded. */
  readonly expectSuccess = (): void => {
    const last = this.lastOutcome;
    if (last === undefined) throw new Error("no dispatch or query happened yet");
    if (Exit.isFailure(last)) {
      throw new Error(
        `expected the last dispatch to succeed, it failed with: ${renderError(last)}`,
      );
    }
  };

  /**
   * Throws (fails the scenario) unless the last outcome failed with `_tag`.
   * When `messageIncludes` is given, the tag's message (or first issue) must
   * contain it, whitespace-normalized.
   */
  readonly expectFailure = (tag: string, messageIncludes?: string): void => {
    const last = this.lastOutcome;
    if (last === undefined) throw new Error("no dispatch or query happened yet");
    if (Exit.isSuccess(last))
      throw new Error(`expected a failure with ${tag}, the dispatch succeeded`);
    const error = causeError(last);
    const actualTag = hasTag(error) ? error._tag : "Unknown";
    if (actualTag !== tag) {
      throw new Error(`expected a failure tagged ${tag}, got ${actualTag}: ${renderError(last)}`);
    }
    if (messageIncludes !== undefined) {
      const actual = norm(message(error));
      if (!actual.includes(norm(messageIncludes))) {
        throw new Error(
          `failure ${tag} message does not contain "${messageIncludes}": "${actual}"`,
        );
      }
    }
  };

  /**
   * Every stored event, in global order. Requires `EventStore` in the world
   * context — for event-type assertions ("a BookingRequested event should
   * have been dispatched").
   */
  readonly events = (): EventStore extends R
    ? Effect.Effect<ReadonlyArray<StoredEvent>, never, never>
    : WorldMissing<"EventStore"> =>
    Effect.map(
      this.use(
        Effect.flatMap(EventStore, (store) =>
          Stream.runCollect(store.readAll()),
        ) as unknown as Effect.Effect<ReadonlyArray<StoredEvent>, never, R>,
      ),
      (events) => [...events],
    ) as unknown as EventStore extends R
      ? Effect.Effect<ReadonlyArray<StoredEvent>, never, never>
      : WorldMissing<"EventStore">;
}

const causeError = (failure: Exit.Failure<unknown, unknown>): unknown => {
  const cause: unknown = failure.cause;
  if (typeof cause === "object" && cause !== null && "error" in cause) {
    return (cause as { readonly error: unknown }).error;
  }
  return cause;
};

const message = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "issues" in error &&
    Array.isArray((error as { issues: unknown }).issues)
  ) {
    const issues = (error as { issues: ReadonlyArray<unknown> }).issues;
    return issues.map((issue) => String(issue)).join("; ");
  }
  return String(error);
};

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

const renderError = (failure: Exit.Failure<unknown, unknown>): string => {
  const error = causeError(failure);
  return hasTag(error) ? `${error._tag}: ${message(error)}` : message(error);
};
