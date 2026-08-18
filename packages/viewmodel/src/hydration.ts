import type { SqlClient } from "@effect/sql/SqlClient";
import type {
  CheckpointStore,
  EventDecodeError,
  EventRegistry,
  EventStore,
  StoredEvent,
} from "@structure/eventsourcing";
import { Projection } from "@structure/eventsourcing";
import { Effect, type Schema } from "effect";
import type { ViewModelDef } from "./ViewModel.js";
import * as ViewStore from "./ViewStore.js";

/**
 * Delivery context for a view-projection handler: the raw stored event
 * (stream, version, global position, metadata) and the `live` flag — `true`
 * for normal delivery, `false` only while replaying during `rebuild`, so
 * handlers can suppress side effects that must not fire again.
 */
export interface ViewProjectionContext {
  readonly stored: StoredEvent;
  readonly live: boolean;
}

/**
 * Handler for one event type: receives the decoded event, the typed store of
 * the projection's view model, and the delivery context. Delivery is
 * at-least-once (checkpoints save per batch) — handlers must be idempotent.
 */
export type ViewProjectionHandler<E, Store, EH, R> = (
  event: E,
  store: Store,
  context: ViewProjectionContext,
) => Effect.Effect<void, EH, R>;

/**
 * A projection hydrating one view-model table from the global event feed.
 * The checkpoint name is the projection's `name`; one view table must have
 * exactly one writing projection (the store does no concurrency control).
 */
export interface ViewProjection<E extends { readonly _tag: string }, EH, R> {
  /** The underlying eventsourcing projection (store resolved per handler). */
  readonly projection: Projection.Projection<E, EH, R | SqlClient>;
  /** Processes every event from the checkpoint to the head, then returns. */
  readonly catchup: (options?: {
    readonly batchSize?: number;
  }) => Effect.Effect<
    Projection.CatchupStats,
    EH | EventDecodeError,
    EventStore | CheckpointStore | SqlClient | R
  >;
  /** Runs forever: catch up, sleep, repeat. Interrupt the fiber to stop. */
  readonly run: (
    options?: Projection.RunOptions,
  ) => Effect.Effect<never, EH | EventDecodeError, EventStore | CheckpointStore | SqlClient | R>;
  /**
   * Truncates the view table, zeroes the checkpoint, and replays the whole
   * feed with `live: false`.
   */
  readonly rebuild: (options?: {
    readonly batchSize?: number;
  }) => Effect.Effect<
    Projection.CatchupStats,
    EH | EventDecodeError,
    EventStore | CheckpointStore | SqlClient | R
  >;
}

/**
 * Builds a {@link ViewProjection}: `Projection.make` from
 * `@structure/eventsourcing` wrapped so every handler receives the view
 * model's typed {@link ViewStore.ViewStore} (constructed once per
 * `catchup`/`run`/`rebuild` invocation and closed over). Event types missing
 * from the registry are skipped; registered types without a handler are
 * ignored — both per eventsourcing projection semantics.
 *
 * `name` is the checkpoint key: renaming it resets progress, and one view
 * table should have exactly one writing projection.
 */
export const make = <
  Fields extends Schema.Struct.Fields,
  E extends { readonly _tag: string },
  EH = never,
  R = never,
>(options: {
  readonly name: string;
  readonly view: ViewModelDef<Fields>;
  readonly registry: EventRegistry<E>;
  readonly when: Partial<{
    readonly [Tag in E["_tag"]]: ViewProjectionHandler<
      Extract<E, { readonly _tag: Tag }>,
      ViewStore.ViewStore<
        Schema.Schema.Type<Schema.Struct<Fields>>,
        Schema.Schema.Encoded<Schema.Struct<Fields>>
      >,
      EH,
      R
    >;
  }>;
}): ViewProjection<E, EH, R> => {
  type Store = ViewStore.ViewStore<
    Schema.Schema.Type<Schema.Struct<Fields>>,
    Schema.Schema.Encoded<Schema.Struct<Fields>>
  >;
  const handlers = options.when as Partial<Record<string, ViewProjectionHandler<E, Store, EH, R>>>;

  const adaptWith = <R2>(
    resolve: (
      handler: ViewProjectionHandler<E, Store, EH, R>,
      event: E,
      context: ViewProjectionContext,
    ) => Effect.Effect<void, EH, R2>,
  ): Projection.Projection<E, EH, R2> => {
    const when: Record<string, Projection.ProjectionHandler<E, EH, R2>> = {};
    for (const [tag, handler] of Object.entries(handlers)) {
      if (handler === undefined) {
        continue;
      }
      when[tag] = (event, stored, context) =>
        resolve(handler, event, { stored, live: context.live });
    }
    return Projection.make<E, EH, R2>({
      name: options.name,
      registry: options.registry,
      when: when as unknown as Projection.Projection<E, EH, R2>["when"],
    });
  };

  const forStore = (store: Store): Projection.Projection<E, EH, R> =>
    adaptWith((handler, event, context) => handler(event, store, context));

  const withStore = <X, EX, RX>(
    f: (store: Store) => Effect.Effect<X, EX, RX>,
  ): Effect.Effect<X, EX, RX | SqlClient> => Effect.flatMap(ViewStore.make(options.view), f);

  return {
    projection: adaptWith<R | SqlClient>((handler, event, context) =>
      withStore((store) => handler(event, store, context)),
    ),
    catchup: (o) => withStore((store) => Projection.catchup(forStore(store), o)),
    run: (o) => withStore((store) => Projection.run(forStore(store), o)),
    rebuild: (o) => withStore((store) => Projection.rebuild(forStore(store), store.truncate, o)),
  };
};
