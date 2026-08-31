import {
  layer as busesLayer,
  type CommandBus,
  CommandHandler,
  HandlerRegistry,
  type QueryBus,
  QueryHandler,
} from "@structure-ai/cqrs";
import {
  EventRegistry,
  EventStore,
  type EventStoreService,
  InMemoryAll,
  Projection,
} from "@structure-ai/eventsourcing";
import { Context, Effect, Layer, Stream } from "effect";
import {
  AddTodo,
  CompleteTodo,
  ListTodos,
  TodoAdded,
  TodoCompleted,
  type TodoEvent,
  TodoNotFound,
} from "./messages.js";

// --- read model -----------------------------------------------------------------

export interface TodoRow {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
}

/** The projected read model the query serves. */
export class TodoView extends Context.Tag("fixture/TodoView")<TodoView, Map<string, TodoRow>>() {}

// --- event registry and projection ------------------------------------------------

const registry = EventRegistry.make([
  { schema: TodoAdded, schemaVersion: 1 },
  { schema: TodoCompleted, schemaVersion: 1 },
]);

const todoProjection = Projection.make<TodoEvent, never, TodoView>({
  name: "todo-view",
  registry,
  when: {
    TodoAdded: (event) =>
      Effect.map(TodoView, (view) => {
        view.set(event.todoId, { id: event.todoId, title: event.title, done: false });
      }),
    TodoCompleted: (event) =>
      Effect.map(TodoView, (view) => {
        const row = view.get(event.todoId);
        if (row !== undefined) view.set(event.todoId, { ...row, done: true });
      }),
  },
}) as unknown as Projection.Projection<{ readonly _tag: string }, never, TodoView>;

/** The drain hook: catches the projection up with the event store. */
export const drain = Effect.asVoid(Projection.catchup(todoProjection));

// --- handlers ---------------------------------------------------------------------

const streamVersion = (store: EventStoreService, streamName: string) =>
  Stream.runCollect(store.read(streamName)).pipe(Effect.map((events) => events.length));

const metadata = (todoId: string, aggregateVersion: number) => ({
  eventId: `evt-${todoId}-${aggregateVersion}`,
  occurredAt: new Date().toISOString(),
  aggregateName: "Todo",
  aggregateId: todoId,
  aggregateVersion,
});

const handleAdd = CommandHandler.make(AddTodo, (payload) =>
  Effect.gen(function* () {
    const view = yield* TodoView;
    const todoId = `todo-${view.size + 1}`;
    const event: TodoEvent = { _tag: "TodoAdded", todoId, title: payload.title };
    const store = yield* EventStore;
    const serialized = registry.encode(event);
    yield* store
      .append(`todo-${todoId}`, 0, [{ ...serialized, metadata: metadata(todoId, 1) }])
      .pipe(Effect.orDie);
    return { todoId };
  }),
);

const handleComplete = CommandHandler.make(CompleteTodo, (payload) =>
  Effect.gen(function* () {
    const view = yield* TodoView;
    if (!view.has(payload.todoId)) {
      return yield* Effect.fail(new TodoNotFound({ todoId: payload.todoId }));
    }
    const store = yield* EventStore;
    const version = yield* streamVersion(store, `todo-${payload.todoId}`);
    const event: TodoEvent = { _tag: "TodoCompleted", todoId: payload.todoId };
    const serialized = registry.encode(event);
    yield* store
      .append(`todo-${payload.todoId}`, version, [
        { ...serialized, metadata: metadata(payload.todoId, version + 1) },
      ])
      .pipe(Effect.orDie);
    return { done: true as const };
  }),
);

const handleList = QueryHandler.make(ListTodos, () =>
  Effect.map(TodoView, (view) => ({
    todos: [...view.values()].map(({ id, title, done }) => ({ id, title, done })),
  })),
);

// --- composition --------------------------------------------------------------------

export type FixtureServices = CommandBus | QueryBus | EventStore | TodoView;

// One TodoView instance satisfies both the handlers (via the registry) and
// the drain's projection — provideMerge exposes it while providing it, and
// layer memoization keeps it a single map.
const TodoViewLive = Layer.succeed(TodoView, new Map());

export const FixtureLive = busesLayer
  .pipe(Layer.provide(HandlerRegistry.layer(handleAdd, handleComplete, handleList)))
  .pipe(Layer.provideMerge(TodoViewLive))
  .pipe(Layer.provideMerge(InMemoryAll));
