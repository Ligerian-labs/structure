import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as HttpServer from "@effect/platform/HttpServer";
import {
  type AnyMessageDefinition,
  type AuthorizationRequest,
  Authorizer,
  Command,
  CommandBus,
  CommandHandler,
  HandlerRegistry,
  IdempotencyStore,
  Query,
  QueryBus,
  QueryHandler,
} from "@structure-ai/cqrs";
import { InMemoryAll } from "@structure-ai/eventsourcing";
import { Context, Effect, Exit, Layer, Schema, Scope } from "effect";
import { TestControl } from "../src/index.js";

// --- fixture messages ------------------------------------------------------------

const AddItem = Command.define("AddItem", {
  payload: Schema.Struct({ name: Schema.NonEmptyString }),
  success: Schema.Struct({ id: Schema.String, name: Schema.String }),
});

const ListItems = Query.define("ListItems", {
  payload: Schema.Struct({}),
  success: Schema.Struct({ items: Schema.Array(Schema.String) }),
});

class ItemClosed extends Schema.TaggedError<ItemClosed>()("ItemClosed", {
  rule: Schema.String,
}) {}

const CloseItem = Command.define("CloseItem", {
  payload: Schema.Struct({ id: Schema.String }),
  success: Schema.Struct({ closed: Schema.Literal(true) }),
  failure: ItemClosed,
});

// --- composition -------------------------------------------------------------------

interface Recorded {
  authorizer: Array<AuthorizationRequest>;
  drains: number;
}

const recorded: Recorded = { authorizer: [], drains: 0 };

const RecordingAuthorizer = Layer.succeed(Authorizer, {
  authorize: (request) =>
    Effect.sync(() => {
      recorded.authorizer.push(request);
    }),
});

const registry = HandlerRegistry.layer(
  CommandHandler.make(AddItem, (payload) =>
    Effect.succeed({ id: `item-${payload.name}`, name: payload.name }),
  ),
  CommandHandler.make(CloseItem, () => Effect.fail(new ItemClosed({ rule: "items are closed" }))),
  QueryHandler.make(ListItems, () => Effect.succeed({ items: ["stapler"] })),
);

const token = "unit-test-control-token";
const commands: Readonly<Record<string, AnyMessageDefinition>> = {
  addItem: AddItem,
  closeItem: CloseItem,
};
const queries: Readonly<Record<string, AnyMessageDefinition>> = { listItems: ListItems };

const drain = Effect.sync(() => {
  recorded.drains += 1;
});

const Live = TestControl.layer({
  port: 0,
  token,
  commands,
  queries,
  drain,
}).pipe(
  // The bare bus layers (not cqrs `layer`, which bakes in Authorizer.allowAll)
  // so the recording authorizer below actually sees every dispatch.
  Layer.provide(
    Layer.mergeAll(CommandBus.layer, QueryBus.layer).pipe(
      Layer.provide(registry),
      Layer.provide(RecordingAuthorizer),
      Layer.provide(IdempotencyStore.inMemory),
    ),
  ),
  Layer.provideMerge(InMemoryAll),
);

// The layer exposes HttpServer; build it in a scope and read the bound address.
const scope = Effect.runSync(Scope.make());
let baseUrl = "";

beforeAll(async () => {
  const context = await Effect.runPromise(Layer.buildWithScope(Live, scope));
  const server = Context.get(context, HttpServer.HttpServer);
  const address = server.address;
  if (address._tag !== "TcpAddress") throw new Error("expected a tcp address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void));
});

// --- calling helpers -----------------------------------------------------------------

const call = async (
  path: string,
  body: unknown,
  // `null` sends no authorization header (explicit `undefined` would trigger
  // the default — the classic default-parameter trap).
  bearer: string | null = token,
  method = "POST",
): Promise<{ status: number; exit: unknown }> => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(bearer !== null ? { authorization: `Bearer ${bearer}` } : {}),
      "content-type": "application/json",
    },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  const exit = await response.json();
  return { status: response.status, exit };
};

// --- tests ------------------------------------------------------------------------------

describe("bearer guard", () => {
  test("rejects requests without the token", async () => {
    const { status } = await call("/commands", { command: "addItem", payload: {} }, null);
    expect(status).toBe(401);
  });

  test("rejects requests with the wrong token", async () => {
    const { status } = await call("/commands", { command: "addItem", payload: {} }, "wrong");
    expect(status).toBe(401);
  });
});

describe("dispatch", () => {
  test("returns the encoded success value", async () => {
    const { status, exit } = await call("/commands", {
      command: "addItem",
      payload: { name: "stapler" },
    });
    expect(status).toBe(200);
    expect(exit).toEqual({ ok: true, value: { id: "item-stapler", name: "stapler" } });
  });

  test("captures business failures as data with their tag", async () => {
    const { exit } = await call("/commands", { command: "closeItem", payload: { id: "x" } });
    expect(exit).toEqual({
      ok: false,
      failure: { tag: "ItemClosed", message: expect.stringContaining("closed") },
    });
  });

  test("unknown commands fail loudly with the registered names", async () => {
    const { exit } = await call("/commands", { command: "nope", payload: {} });
    const failure = (exit as { failure: { tag: string; message: string } }).failure;
    expect(failure.tag).toBe("HandlerNotFound");
    expect(failure.message).toContain("addItem");
    expect(failure.message).toContain("closeItem");
  });

  test("boundary validation failures carry the field issues", async () => {
    const { exit } = await call("/commands", { command: "addItem", payload: { name: 7 } });
    const failure = (exit as { failure: { tag: string; message: string } }).failure;
    expect(failure.tag).toBe("ValidationFailed");
    expect(failure.message).toContain("name");
  });

  test("propagates the actor into authorization", async () => {
    await call("/commands", {
      command: "addItem",
      payload: { name: "actor-probe" },
      actor: "alice",
    });
    const seen = recorded.authorizer.filter((request) => request.payload).at(-1);
    expect(seen?.actor).toBe("alice");
    expect(seen?.tag).toBe("AddItem");
  });

  test("a query definition in the command slot is rejected", async () => {
    const { exit } = await call("/commands", { command: "listItems", payload: {} });
    const failure = (exit as { failure: { tag: string } }).failure;
    expect(failure.tag).toBe("HandlerNotFound");
  });
});

describe("queries", () => {
  test("runs registered queries", async () => {
    const { exit } = await call("/queries", { query: "listItems", payload: {} });
    expect(exit).toEqual({ ok: true, value: { items: ["stapler"] } });
  });
});

describe("drain and reset", () => {
  test("drain runs the registered hook", async () => {
    const before = recorded.drains;
    const { exit } = await call("/drain", {});
    expect(exit).toEqual({ ok: true, value: undefined });
    expect(recorded.drains).toBe(before + 1);
  });

  test("reset without a hook reports NotConfigured", async () => {
    const { exit } = await call("/reset", {});
    expect(exit).toEqual({
      ok: false,
      failure: { tag: "NotConfigured", message: expect.stringContaining("reset") },
    });
  });
});

describe("events", () => {
  test("serves stored events in wire shape", async () => {
    const { status, exit } = await call("/events", undefined, token, "GET");
    expect(status).toBe(200);
    expect(Array.isArray(exit)).toBe(true);
  });
});

describe("auth", () => {
  test("without the auth option reports NotConfigured", async () => {
    const { exit } = await call("/auth/register", {
      email: "a@b.c",
      password: "long enough password",
    });
    expect(exit).toEqual({
      ok: false,
      failure: { tag: "NotConfigured", message: expect.stringContaining("auth") },
    });
  });
});
