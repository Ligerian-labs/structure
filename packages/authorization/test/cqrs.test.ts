import { describe, expect, test } from "bun:test";
import {
  Command,
  CommandBus,
  CommandHandler,
  HandlerRegistry,
  IdempotencyStore,
  Query,
  QueryBus,
  QueryHandler,
  Unauthorized,
} from "@structure-ai/cqrs";
import { Effect, Layer, Option, Schema } from "effect";
import { Condition, CqrsAuthorization, Policy, Principal } from "../src/index.js";

// --- policy and messages -----------------------------------------------------

const policy = Policy.define({
  resources: { invoice: ["read", "approve", "delete"] },
  conditions: { owner: Condition.owner() },
  roles: {
    viewer: { grants: ["invoice:read"] },
    manager: { inherits: ["viewer"], grants: ["invoice:approve"] },
    clerk: { grants: [{ permission: "invoice:delete", when: "owner" }] },
  },
});

const ApproveInvoice = Command.define("ApproveInvoice", {
  payload: Schema.Struct({ invoiceId: Schema.String }),
  success: Schema.Struct({ approved: Schema.Boolean }),
});

const DeleteInvoice = Command.define("DeleteInvoice", {
  payload: Schema.Struct({ invoiceId: Schema.String, ownerId: Schema.String }),
  success: Schema.Struct({ deleted: Schema.Boolean }),
});

const ListInvoices = Query.define("ListInvoices", {
  payload: Schema.Struct({ tenantId: Schema.String }),
  success: Schema.Struct({ count: Schema.Number }),
});

const Ping = Query.define("Ping", {
  payload: Schema.Struct({}),
  success: Schema.Struct({ pong: Schema.Boolean }),
});

const Unmapped = Query.define("Unmapped", {
  payload: Schema.Struct({}),
  success: Schema.Struct({}),
});

const handlers = HandlerRegistry.layer(
  CommandHandler.make(ApproveInvoice, () => Effect.succeed({ approved: true })),
  CommandHandler.make(DeleteInvoice, () => Effect.succeed({ deleted: true })),
  QueryHandler.make(ListInvoices, () => Effect.succeed({ count: 3 })),
  QueryHandler.make(Ping, () => Effect.succeed({ pong: true })),
  QueryHandler.make(Unmapped, () => Effect.succeed({})),
);

const directory: Record<string, Principal> = {
  ada: { id: "ada", roles: ["manager"] },
  bob: { id: "bob", roles: ["viewer", { role: "manager", scope: "tenant:acme" }] },
  cleo: { id: "cleo", roles: ["clerk"] },
};

const rules = CqrsAuthorization.rules(policy, {
  resolvePrincipal: (actor) => Effect.succeed(Option.fromNullable(directory[actor])),
})
  .message(ApproveInvoice, "invoice:approve")
  // Payload-derived attributes feed the conditional grant; typed payload.
  .message(DeleteInvoice, (payload) => ({
    permission: "invoice:delete",
    attributes: { ownerId: payload.ownerId },
  }))
  // Payload-derived scope activates scoped role assignments.
  .message(ListInvoices, (payload) => ({
    permission: "invoice:read",
    scope: `tenant:${payload.tenantId}`,
  }))
  .public(Ping);

const stack = Layer.mergeAll(CommandBus.layer, QueryBus.layer).pipe(
  Layer.provide(Layer.mergeAll(handlers, rules.layer, IdempotencyStore.inMemory)),
);

const run = <A, E>(effect: Effect.Effect<A, E, CommandBus | QueryBus>) =>
  Effect.runPromise(effect.pipe(Effect.provide(stack)));

const as = (id: string) => Principal.within(directory[id] ?? { id, roles: [] });

describe("CqrsAuthorization", () => {
  test("rules cover exactly the mapped tags", () => {
    expect(rules.tags).toEqual(["ApproveInvoice", "DeleteInvoice", "ListInvoices", "Ping"]);
  });

  test("the fiber's principal is authorized per message; denials are cqrs Unauthorized with the decision reason", async () => {
    const approved = await run(
      as("ada")(
        Effect.flatMap(CommandBus, (bus) => bus.dispatch(ApproveInvoice, { invoiceId: "1" })),
      ),
    );
    expect(approved).toEqual({ approved: true });

    const denied = await run(
      as("bob")(
        Effect.flatMap(CommandBus, (bus) =>
          Effect.flip(bus.dispatch(ApproveInvoice, { invoiceId: "1" })),
        ),
      ),
    );
    expect(denied).toBeInstanceOf(Unauthorized);
    const unauthorized = denied as Unauthorized;
    expect(unauthorized.tag).toBe("ApproveInvoice");
    expect(unauthorized.actor).toBe("bob"); // Principal.within tagged the correlation actor
    expect(unauthorized.reason).toBe('no role of [viewer] grants "invoice:approve"');
  });

  test("payload-derived scope and attributes reach the policy", async () => {
    const inScope = await run(
      as("bob")(
        Effect.flatMap(QueryBus, (bus) => bus.dispatch(ListInvoices, { tenantId: "acme" })),
      ),
    );
    expect(inScope).toEqual({ count: 3 });
    // bob holds viewer globally, so reading in another tenant is still allowed by `viewer`...
    const elsewhere = await run(
      as("bob")(Effect.flatMap(QueryBus, (bus) => bus.dispatch(ListInvoices, { tenantId: "x" }))),
    );
    expect(elsewhere).toEqual({ count: 3 });

    const ownDelete = await run(
      as("cleo")(
        Effect.flatMap(CommandBus, (bus) =>
          bus.dispatch(DeleteInvoice, { invoiceId: "7", ownerId: "cleo" }),
        ),
      ),
    );
    expect(ownDelete).toEqual({ deleted: true });
    const foreignDelete = await run(
      as("cleo")(
        Effect.flatMap(CommandBus, (bus) =>
          Effect.flip(bus.dispatch(DeleteInvoice, { invoiceId: "7", ownerId: "ada" })),
        ),
      ),
    );
    expect((foreignDelete as Unauthorized).reason).toBe(
      "conditional grant(s) not met: clerk (owner)",
    );
  });

  test("unmapped messages are denied (fail closed); public ones pass without a principal", async () => {
    const unmapped = await run(
      as("ada")(Effect.flatMap(QueryBus, (bus) => Effect.flip(bus.dispatch(Unmapped, {})))),
    );
    expect((unmapped as Unauthorized).reason).toBe('no authorization rule for "Unmapped"');

    const pong = await run(Effect.flatMap(QueryBus, (bus) => bus.dispatch(Ping, {})));
    expect(pong).toEqual({ pong: true });

    const anonymous = await run(
      Effect.flatMap(CommandBus, (bus) =>
        Effect.flip(bus.dispatch(ApproveInvoice, { invoiceId: "1" })),
      ),
    );
    expect((anonymous as Unauthorized).reason).toBe("unauthenticated: no principal attached");
  });

  test("without a fiber principal, the dispatch actor is resolved through resolvePrincipal", async () => {
    const viaActor = await run(
      Effect.flatMap(CommandBus, (bus) =>
        bus.dispatch(ApproveInvoice, { invoiceId: "1" }, { actor: "ada" }),
      ),
    );
    expect(viaActor).toEqual({ approved: true });

    const unknownActor = await run(
      Effect.flatMap(CommandBus, (bus) =>
        Effect.flip(bus.dispatch(ApproveInvoice, { invoiceId: "1" }, { actor: "nobody" })),
      ),
    );
    expect((unknownActor as Unauthorized).actor).toBe("nobody");
    expect((unknownActor as Unauthorized).reason).toBe("unauthenticated: no principal attached");
  });

  test("unmapped: 'allow' opts into open-by-default (explicitly)", async () => {
    const open = CqrsAuthorization.rules(policy, { unmapped: "allow" }).layer;
    const openStack = Layer.mergeAll(CommandBus.layer, QueryBus.layer).pipe(
      Layer.provide(Layer.mergeAll(handlers, open, IdempotencyStore.inMemory)),
    );
    const result = await Effect.runPromise(
      Effect.flatMap(QueryBus, (bus) => bus.dispatch(Unmapped, {})).pipe(Effect.provide(openStack)),
    );
    expect(result).toEqual({});
  });
});
