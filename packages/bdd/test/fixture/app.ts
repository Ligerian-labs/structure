import {
  layer as busesLayer,
  type CommandBus,
  CommandHandler,
  HandlerRegistry,
  type QueryBus,
  QueryHandler,
} from "@structure-ai/cqrs";
import {
  type CheckpointStore,
  EventRegistry,
  EventStore,
  InMemoryAll,
  Outbox,
  Projection,
} from "@structure-ai/eventsourcing";
import { Context, Effect, Layer, type Schema, type Scope } from "effect";
import { ScenarioWorld, TestAuth, type TestAuth as TestAuthService } from "../../src/index.js";
import {
  AlreadyBooked,
  InvalidPeriod,
  ListReservations,
  RequestReservation,
  ReservationRequested,
} from "./messages.js";

// --- app doubles -------------------------------------------------------------

/** Nightly rates per resource, installed by `Given` steps. */
export class Rates extends Context.Tag("fixture/Rates")<Rates, Map<string, number>>() {}

/** The projected read model: reservations ready to be listed. */
export class ReservationView extends Context.Tag("fixture/ReservationView")<
  ReservationView,
  Map<
    string,
    {
      readonly id: string;
      readonly from: string;
      readonly to: string;
      readonly totalAmount: string;
    }
  >
>() {}

export interface SentMail {
  readonly to: string;
  readonly subject: string;
}

/** Doubles the suite's steps read directly (recorded mails). */
export class Mails extends Context.Tag("fixture/Mails")<Mails, Array<SentMail>>() {}

// --- event registry and projection --------------------------------------------

const registry = EventRegistry.make([{ schema: ReservationRequested, schemaVersion: 1 }]);

const reservationProjection = Projection.make<ReservationRequested, never, ReservationView>({
  name: "reservation-view",
  registry: registry as never,
  when: {
    ReservationRequested: (event, _stored, _context) =>
      Effect.map(ReservationView, (view) => {
        view.set(event.reservationId, {
          id: event.reservationId,
          from: event.from,
          to: event.to,
          totalAmount: event.totalAmount,
        });
      }),
  },
}) as unknown as Projection.Projection<{ readonly _tag: string }, never, ReservationView>;

// --- handlers -----------------------------------------------------------------

const overlaps = (aFrom: string, aTo: string, bFrom: string, bTo: string): boolean =>
  aFrom < bTo && bFrom < aTo;

const handleRequest = CommandHandler.make(RequestReservation, (payload) =>
  Effect.gen(function* () {
    if (payload.from >= payload.to) {
      return yield* Effect.fail(
        new InvalidPeriod({
          message: `End date ${payload.to} cannot be before start date ${payload.from}`,
        }),
      );
    }
    const rates = yield* Rates;
    const rate = rates.get(payload.resourceId);
    if (rate === undefined) {
      return yield* Effect.fail(
        new InvalidPeriod({ message: `Unknown resource ${payload.resourceId}` }),
      );
    }
    const view = yield* ReservationView;
    for (const reservation of view.values()) {
      if (overlaps(payload.from, payload.to, reservation.from, reservation.to)) {
        return yield* Effect.fail(
          new AlreadyBooked({ from: reservation.from, to: reservation.to }),
        );
      }
    }
    const nights = (Date.parse(payload.to) - Date.parse(payload.from)) / (24 * 60 * 60 * 1000);
    const totalAmount = `${(nights * rate).toLocaleString("fr-FR", { minimumFractionDigits: 2 })} €`;
    const reservationId = `res-${view.size + 1}`;
    const event: Schema.Schema.Type<typeof ReservationRequested> = {
      _tag: "ReservationRequested",
      reservationId,
      resourceId: payload.resourceId,
      from: payload.from,
      to: payload.to,
      totalAmount,
    };
    const store = yield* EventStore;
    const serialized = registry.encode(event);
    yield* store
      .append(`reservation-${reservationId}`, 0, [
        {
          ...serialized,
          metadata: {
            eventId: `evt-${reservationId}`,
            occurredAt: new Date().toISOString(),
            aggregateName: "Reservation",
            aggregateId: reservationId,
            aggregateVersion: 1,
          },
        },
      ])
      .pipe(Effect.orDie);
    const outbox = yield* Outbox;
    yield* outbox.enqueue([
      {
        id: `mail-${reservationId}`,
        topic: "reservations",
        payload: event,
        metadata: {},
      },
    ]);
    return { reservationId, totalAmount };
  }),
);

const handleList = QueryHandler.make(ListReservations, () =>
  Effect.map(ReservationView, (view) => ({
    reservations: [...view.values()].map(({ id, from, to, totalAmount }) => ({
      id,
      from,
      to,
      totalAmount,
    })),
  })),
);

// --- world --------------------------------------------------------------------

export type WorldServices =
  | CommandBus
  | QueryBus
  | EventStore
  | Outbox
  | CheckpointStore
  | Rates
  | ReservationView
  | Mails;

/**
 * The fixture world: doubles as plain fields for the steps (mails) plus
 * scenario state the step definitions share.
 */
export class FixtureWorld extends ScenarioWorld<WorldServices> {
  /** The in-memory auth stack (real service, recorded e-mails). */
  readonly testAuth: TestAuthService;
  registeredProfiles: Array<{ readonly email: string; readonly birthdateIso: string }> = [];
  /** Session tokens per e-mail, recorded by sign-in steps. */
  readonly sessionTokens = new Map<string, string>();

  constructor(
    scope: Scope.Scope,
    context: Context.Context<WorldServices>,
    testAuth: TestAuthService,
  ) {
    super(scope, context);
    this.testAuth = testAuth;
  }

  lastReservation?: { readonly reservationId: string; readonly totalAmount: string };
  pendingRequest?: { readonly from: string; readonly to: string };
  policyNote?: string;
  policyAcknowledged?: boolean;
}

const DoublesLive = (mails: Array<SentMail>) =>
  Layer.mergeAll(
    Layer.succeed(Rates, new Map()),
    Layer.succeed(ReservationView, new Map()),
    Layer.succeed(Mails, mails),
  );

const registryLayer = HandlerRegistry.layer(handleRequest, handleList);

export const buildTestWorld = (scope: Scope.Scope): Effect.Effect<FixtureWorld, never, never> =>
  Effect.gen(function* () {
    const mails: Array<SentMail> = [];
    const worldLayer = Layer.mergeAll(
      busesLayer.pipe(Layer.provide(registryLayer)),
      DoublesLive(mails),
    ).pipe(Layer.provideMerge(InMemoryAll));
    const context = yield* Layer.buildWithScope(worldLayer, scope);
    const testAuth = TestAuth.make({
      tenantId: "fixture",
      baseUrl: new URL("http://localhost:3000"),
      tenant: { password: { minLength: 6 } },
    });
    return new FixtureWorld(scope, context, testAuth);
  }).pipe(Effect.orDie) as Effect.Effect<FixtureWorld, never, never>;

/**
 * The drain: delivers outbox mails (the recording double) and catches the
 * projection up with the event store — after every step, so `Then` steps
 * always observe converged state.
 */
export const drainWorld = (world: FixtureWorld): Effect.Effect<void, unknown, WorldServices> =>
  Effect.gen(function* () {
    yield* world.use(
      Effect.flatMap(Outbox, (outbox) =>
        Effect.flatMap(outbox.pending(32), (entries) =>
          Effect.forEach(entries, (entry) =>
            Effect.flatMap(Mails, (record) =>
              Effect.sync(() => {
                const payload = entry.message.payload as { reservationId: string };
                record.push({
                  to: `customer+${payload.reservationId}@example.test`,
                  subject: "Votre réservation",
                });
              }),
            ).pipe(Effect.andThen(outbox.markPublished([entry.message.id]))),
          ),
        ),
      ),
    );
    yield* world.use(Effect.asVoid(Projection.catchup(reservationProjection)));
  }).pipe(Effect.mapError((error) => new Error(`drain failed: ${String(error)}`))) as Effect.Effect<
    void,
    unknown,
    WorldServices
  >;
