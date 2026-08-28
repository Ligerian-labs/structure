import { Effect, Exit, Schema } from "effect";
import { Given, type StepDefinition, Then, When } from "../../src/index.js";
import { type FixtureWorld, Mails, Rates } from "../fixture/app.js";
import { ListReservations, RequestReservation } from "../fixture/messages.js";

const customerRow = Schema.Struct({ email: Schema.String });

const bookingRow = Schema.Struct({
  customer: Schema.String,
  from: Schema.String,
  to: Schema.String,
  guests: Schema.NumberFromString,
});

/** Submits a request as the given actor and records the accepted result. */
const submitAs = (world: FixtureWorld, actorId: string, from: string, to: string) =>
  Effect.gen(function* () {
    const exit = yield* world.dispatch(
      RequestReservation,
      { resourceId: "savanne", from, to },
      { actor: actorId },
    );
    if (Exit.isSuccess(exit)) {
      world.lastReservation = exit.value;
    }
  });

/** Whitespace-normalized comparison: locale formatting may emit non-breaking spaces. */
const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

/** The current actor, or a registered one by e-mail. */
const actorOf = (world: FixtureWorld, email?: string): string => {
  const actor = email !== undefined ? world.actorNamed(email) : world.currentActor;
  if (actor === undefined) {
    throw new Error(email === undefined ? "no actor signed in" : `unknown actor ${email}`);
  }
  return actor.id;
};

export const reservationSteps = [
  Given("a nightly rate of {int} € for villa {string}", ({ world, params }) =>
    world.use(
      Effect.map(Rates, (rates) => {
        const [rate, villa] = params as [number, string];
        rates.set(villa, rate);
      }),
    ),
  ),

  Given("registered customers:", ({ world, table }) =>
    world.use(
      Effect.gen(function* () {
        const rows = table !== undefined ? yield* table.rows(customerRow) : [];
        for (const row of rows) world.signIn(row.email, `user-${row.email}`);
      }),
    ),
  ),

  Given("{string} is logged in", ({ world, params }) => {
    const [email] = params as [string];
    const actor = world.actorNamed(email);
    if (actor === undefined) throw new Error(`${email} must be registered first`);
    world.signIn(actor.name, actor.id);
  }),

  Given("a booking request from {string} to {string}", ({ world, params }) => {
    const [from, to] = params as [string, string];
    world.pendingRequest = { from, to };
  }),

  Given("the villa is already booked:", ({ world, table }) =>
    world.use(
      Effect.gen(function* () {
        const rows = table !== undefined ? yield* table.rows(bookingRow) : [];
        for (const row of rows) {
          yield* submitAs(world, actorOf(world, row.customer), row.from, row.to);
          world.expectSuccess();
        }
      }),
    ),
  ),

  Given("the customer read the cancellation policy:", ({ world, doc }) => {
    if (doc !== undefined) world.policyNote = doc;
  }),

  When("the customer submits the booking request", ({ world }) => {
    const request = world.pendingRequest;
    if (request === undefined) throw new Error("no booking request was prepared");
    return world.use(submitAs(world, actorOf(world), request.from, request.to));
  }),

  When("a booking request is made with the policy acknowledged", ({ world }) =>
    world.use(
      Effect.gen(function* () {
        const note = world.policyNote;
        if (note === undefined) throw new Error("no policy note was read");
        world.policyAcknowledged = note.includes("Caution");
        yield* submitAs(world, actorOf(world), "2026-07-01", "2026-07-15");
      }),
    ),
  ),

  Then("it is accepted with a total of {string}", ({ world, params }) => {
    const [total] = params as [string];
    world.expectSuccess();
    const reservation = world.lastReservation;
    if (reservation === undefined) throw new Error("no reservation was accepted");
    if (norm(reservation.totalAmount) !== norm(total)) {
      throw new Error(`expected a total of ${total}, got ${reservation.totalAmount}`);
    }
  }),

  Then("an exception {string} should be thrown with message {string}", ({ world, params }) => {
    const [tag, message] = params as [string, string];
    world.expectFailure(tag, message);
  }),

  Then("an exception {string} should be thrown", ({ world, params }) => {
    const [tag] = params as [string];
    world.expectFailure(tag);
  }),

  Then("{int} email(s) should have been sent", ({ world, params }) => {
    const [count] = params as [number];
    return world.use(
      Effect.map(Mails, (mails) => {
        if (mails.length !== count) {
          throw new Error(`expected ${count} emails, ${mails.length} were sent`);
        }
      }),
    );
  }),

  Then('a "ReservationRequested" event should have been dispatched', ({ world }) =>
    Effect.map(world.events(), (events) => {
      if (!events.some((event) => event.type === "ReservationRequested")) {
        throw new Error(
          `expected a ReservationRequested event, got: ${events.map((event) => event.type).join(", ") || "none"}`,
        );
      }
    }),
  ),

  Then("the villa should show {int} reservation(s)", ({ world, params }) => {
    const [count] = params as [number];
    return Effect.map(world.query(ListReservations, {}), (exit) => {
      const reservations = Exit.isSuccess(exit) ? exit.value.reservations : [];
      if (reservations.length !== count) {
        throw new Error(`expected ${count} reservations, found ${reservations.length}`);
      }
    });
  }),

  Then("the acknowledgement is recorded", ({ world }) => {
    if (world.policyAcknowledged !== true) throw new Error("the policy was not acknowledged");
  }),
] as const satisfies ReadonlyArray<StepDefinition<FixtureWorld>>;
