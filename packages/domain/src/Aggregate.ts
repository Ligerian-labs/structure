import { Effect } from "effect";
import type { DomainError } from "./errors.js";

/**
 * An aggregate as a decider: `decide` accepts or rejects a command against
 * current state and returns the resulting events; `evolve` folds an accepted
 * event into state. The same definition drives state-stored persistence
 * (save the folded state) and event sourcing (save the events).
 */
export interface Aggregate<State, Command, Event, Error = DomainError> {
  readonly name: string;
  /** State before any event was applied. */
  readonly initial: State;
  /** Business decision: reject with a domain error or emit events. Pure aside from the Effect context. */
  readonly decide: (state: State, command: Command) => Effect.Effect<ReadonlyArray<Event>, Error>;
  /** Applies one accepted event. Must be total and side-effect free. */
  readonly evolve: (state: State, event: Event) => State;
}

export const define = <State, Command, Event, Error = DomainError>(
  definition: Aggregate<State, Command, Event, Error>,
): Aggregate<State, Command, Event, Error> => definition;

/** Rebuilds state by folding a history of events from `initial`. */
export const rehydrate = <State, Command, Event, Error>(
  aggregate: Aggregate<State, Command, Event, Error>,
  events: Iterable<Event>,
  from: State = aggregate.initial,
): State => {
  let state = from;
  for (const event of events) {
    state = aggregate.evolve(state, event);
  }
  return state;
};

/**
 * Runs one command against a state: decide, then evolve through the emitted
 * events. Returns the new state and the events for persistence/publication.
 */
export const execute = <State, Command, Event, Error>(
  aggregate: Aggregate<State, Command, Event, Error>,
  state: State,
  command: Command,
): Effect.Effect<{ readonly state: State; readonly events: ReadonlyArray<Event> }, Error> =>
  Effect.map(aggregate.decide(state, command), (events) => ({
    state: rehydrate(aggregate, events, state),
    events,
  }));
