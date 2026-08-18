import { Context, type Effect } from "effect";
import type { ConcurrencyConflict, NotFound } from "./errors.js";

/**
 * Loads and saves one aggregate type behind a domain-oriented contract.
 * No arbitrary cross-aggregate queries — those belong to read models.
 */
export interface Repository<Id, A> {
  readonly load: (id: Id) => Effect.Effect<Versioned<A>, NotFound>;
  /**
   * Persists the aggregate. `expectedVersion` is the version that was
   * loaded; a mismatch fails with `ConcurrencyConflict` instead of silently
   * overwriting newer state. Use version 0 for creation.
   */
  readonly save: (
    id: Id,
    value: A,
    expectedVersion: number,
  ) => Effect.Effect<Versioned<A>, ConcurrencyConflict>;
}

export interface Versioned<A> {
  readonly value: A;
  readonly version: number;
}

/** Creates a Context tag for a repository service. */
export const Tag = <Id, A>() => {
  return <const Key extends string>(key: Key) => Context.GenericTag<Repository<Id, A>>(key);
};
