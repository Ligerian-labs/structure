import {
  Api,
  ApiGroup,
  annotate,
  Health,
  HttpApiBuilder,
  HttpCqrs,
  serve,
} from "@structure-ai/http";
import { layerSilent } from "@structure-ai/observability";
import { launch, Readiness, Shutdown } from "@structure-ai/runtime";
import { Duration, Effect, Layer } from "effect";
import { RecordingAuth, TestControl } from "../../src/index.js";
import { drain, FixtureLive } from "./app.js";
import { AddTodo, CompleteTodo, ListTodos } from "./messages.js";

// The test entrypoint mirrors src/main.ts but composes the control plane:
// compose this only where STRUCTURE_TEST_CONTROL_* is injected (e2e runs).

const port = Number(process.env.TODO_APP_PORT ?? 3100);
const { port: controlPort, token } = TestControl.fromEnv();

const todos = ApiGroup.make("todos")
  .add(HttpCqrs.commandEndpoint("addTodo", "/todos", AddTodo))
  .add(HttpCqrs.commandEndpoint("completeTodo", "/todos/complete", CompleteTodo))
  .add(HttpCqrs.queryEndpoint("listTodos", "/todos", ListTodos));

const todoApi = Api.make("todo-fixture")
  .add(todos)
  .add(Health.group)
  .pipe(annotate({ title: "Todo fixture", version: "1.0.0" }));

const TodosLive = HttpApiBuilder.group(todoApi, "todos", (handlers) =>
  handlers
    .handle("addTodo", HttpCqrs.command(AddTodo))
    .handle("completeTodo", HttpCqrs.command(CompleteTodo))
    .handle("listTodos", HttpCqrs.query(ListTodos)),
);

const ServerLive = serve({ port }).pipe(
  Layer.provide(
    HttpApiBuilder.api(todoApi).pipe(Layer.provide([TodosLive, Health.layer(todoApi)])),
  ),
);

const auth = RecordingAuth.make({
  tenantId: "todo-fixture",
  baseUrl: new URL(`http://127.0.0.1:${port}`),
});

const ControlLive = TestControl.layer({
  port: controlPort,
  token,
  commands: { addTodo: AddTodo, completeTodo: CompleteTodo },
  queries: { listTodos: ListTodos },
  drain,
  auth: { tenantId: auth.tenantId, service: auth.auth, emails: auth.emails },
});

const ServersLive = Layer.merge(ServerLive, ControlLive).pipe(
  Layer.provide(FixtureLive),
  Layer.provide(layerSilent),
);

// Servers live for the program's lifetime: built in the program's scope
// (Bun binds both ports at layer build), readiness flipped only once they
// exist — so /health/ready answering implies the control port is live.
const program = Effect.scoped(
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    yield* Layer.buildWithScope(ServersLive, scope);
    const readiness = yield* Readiness;
    const shutdown = yield* Shutdown;
    yield* readiness.setReady;
    yield* shutdown.awaitShutdown;
  }),
);

launch(program, {
  layers: Layer.provideMerge(Shutdown.layer(), Readiness.layer),
  gracePeriod: Duration.seconds(10),
});
