import { describe, expect, test } from "bun:test";
import { Effect, Either, Exit, Schema } from "effect";
import { Aggregate, DomainEvent, EntityId, InvariantViolation, ValueObject } from "../src/index.js";

const InvoiceId = EntityId.define("InvoiceId");

const Money = ValueObject.define(
  "Money",
  Schema.Struct({
    amount: Schema.Number.pipe(Schema.nonNegative()),
    currency: Schema.Literal("EUR", "USD"),
  }),
);

const InvoiceApproved = DomainEvent.define("InvoiceApproved", {
  invoiceId: InvoiceId.schema,
  approver: Schema.String,
});
const InvoiceRejected = DomainEvent.define("InvoiceRejected", {
  invoiceId: InvoiceId.schema,
  reason: Schema.String,
});
type InvoiceEvent = typeof InvoiceApproved.Type | typeof InvoiceRejected.Type;

interface InvoiceState {
  readonly status: "pending" | "approved" | "rejected";
}
type InvoiceCommand =
  | {
      readonly _tag: "ApproveInvoice";
      readonly id: EntityId.Of<typeof InvoiceId>;
      readonly approver: string;
    }
  | {
      readonly _tag: "RejectInvoice";
      readonly id: EntityId.Of<typeof InvoiceId>;
      readonly reason: string;
    };

const Invoice = Aggregate.define<InvoiceState, InvoiceCommand, InvoiceEvent, InvariantViolation>({
  name: "Invoice",
  initial: { status: "pending" },
  decide: (state, command) => {
    if (state.status !== "pending") {
      return Effect.fail(new InvariantViolation({ rule: "only a pending invoice can be decided" }));
    }
    switch (command._tag) {
      case "ApproveInvoice":
        return Effect.succeed([
          InvoiceApproved.make({ invoiceId: command.id, approver: command.approver }),
        ]);
      case "RejectInvoice":
        return Effect.succeed([
          InvoiceRejected.make({ invoiceId: command.id, reason: command.reason }),
        ]);
    }
  },
  evolve: (state, event) => {
    switch (event._tag) {
      case "InvoiceApproved":
        return { status: "approved" };
      case "InvoiceRejected":
        return { status: "rejected" };
      default:
        return state;
    }
  },
});

describe("EntityId", () => {
  test("brands and validates", () => {
    expect(InvoiceId.make("inv-1")).toBe("inv-1" as EntityId.Of<typeof InvoiceId>);
    expect(() => InvoiceId.make("")).toThrow();
    expect(InvoiceId.generate()).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("ValueObject", () => {
  test("validates structurally and reports all issues", () => {
    const ok = Money.from({ amount: 10, currency: "EUR" });
    expect(Either.isRight(ok)).toBe(true);
    const bad = Money.from({ amount: -1, currency: "GBP" });
    expect(Either.isLeft(bad)).toBe(true);
    if (Either.isLeft(bad)) {
      expect(bad.left._tag).toBe("ValidationFailed");
      expect(bad.left.issues.length).toBeGreaterThanOrEqual(2);
      expect(bad.left.issues.join("\n")).toContain("amount");
    }
  });
});

describe("Aggregate", () => {
  const id = InvoiceId.make("inv-1");

  test("accepts a command and evolves state", async () => {
    const result = await Effect.runPromise(
      Aggregate.execute(Invoice, Invoice.initial, { _tag: "ApproveInvoice", id, approver: "ada" }),
    );
    expect(result.state.status).toBe("approved");
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?._tag).toBe("InvoiceApproved");
  });

  test("rejects a command violating an invariant", async () => {
    const approved = Aggregate.rehydrate(Invoice, [
      InvoiceApproved.make({ invoiceId: id, approver: "ada" }),
    ]);
    const exit = await Effect.runPromiseExit(
      Aggregate.execute(Invoice, approved, { _tag: "RejectInvoice", id, reason: "late" }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("rehydrates from history", () => {
    const state = Aggregate.rehydrate(Invoice, [
      InvoiceRejected.make({ invoiceId: id, reason: "duplicate" }),
    ]);
    expect(state.status).toBe("rejected");
  });
});
