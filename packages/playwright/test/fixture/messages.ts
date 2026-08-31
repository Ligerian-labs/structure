import { Command, Query } from "@structure-ai/cqrs";
import { Schema } from "effect";

/** Business failure: completing a todo that does not exist. */
export class TodoNotFound extends Schema.TaggedError<TodoNotFound>()("TodoNotFound", {
  todoId: Schema.String,
}) {}

export const AddTodo = Command.define("AddTodo", {
  payload: Schema.Struct({ title: Schema.String }),
  success: Schema.Struct({ todoId: Schema.String }),
});

export const CompleteTodo = Command.define("CompleteTodo", {
  payload: Schema.Struct({ todoId: Schema.String }),
  success: Schema.Struct({ done: Schema.Literal(true) }),
  failure: TodoNotFound,
});

export const ListTodos = Query.define("ListTodos", {
  payload: Schema.Struct({}),
  success: Schema.Struct({
    todos: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        title: Schema.String,
        done: Schema.Boolean,
      }),
    ),
  }),
});

/** The integration facts of this fixture domain. */
export const TodoAdded = Schema.Struct({
  _tag: Schema.Literal("TodoAdded"),
  todoId: Schema.String,
  title: Schema.String,
});

export const TodoCompleted = Schema.Struct({
  _tag: Schema.Literal("TodoCompleted"),
  todoId: Schema.String,
});

export type TodoEvent =
  | Schema.Schema.Type<typeof TodoAdded>
  | Schema.Schema.Type<typeof TodoCompleted>;
