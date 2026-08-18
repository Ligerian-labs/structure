import { Aggregate, DomainEvent, InvariantViolation } from "@structure/domain";
import { Effect, Schema } from "effect";
import { EventRegistry, type StoredEventMetadata } from "../src/index.js";

export const Incremented = DomainEvent.define("Incremented", { amount: Schema.Number });
export type CounterEvent = typeof Incremented.Type;

export interface CounterState {
  readonly total: number;
}

export interface Increment {
  readonly _tag: "Increment";
  readonly amount: number;
}

/** Minimal event-sourced aggregate used across the test suite. */
export const Counter = Aggregate.define<CounterState, Increment, CounterEvent, InvariantViolation>({
  name: "Counter",
  initial: { total: 0 },
  decide: (_state, command) =>
    command.amount <= 0
      ? Effect.fail(new InvariantViolation({ rule: "amount must be positive" }))
      : Effect.succeed([Incremented.make({ amount: command.amount })]),
  evolve: (state, event) => ({ total: state.total + event.amount }),
});

export const counterRegistry = EventRegistry.make([{ schema: Incremented, schemaVersion: 1 }]);

/** Hand-built stored metadata for direct EventStore tests. */
export const testMetadata = (aggregateVersion: number): StoredEventMetadata => ({
  eventId: crypto.randomUUID(),
  occurredAt: new Date().toISOString(),
  aggregateName: "Counter",
  aggregateId: "test",
  aggregateVersion,
});
