import { Effect, Exit } from "effect";
import { Given, type StepDefinition, Then, When } from "../../src/index.js";
import { type FixtureWorld, Rates } from "../fixture/app.js";
import { RequestReservation } from "../fixture/messages.js";

/** Adds `days` to an ISO date. */
const isoPlusDays = (iso: string, days: number): string => {
  const date = new Date(Date.parse(iso));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

/** Whitespace-normalized comparison (espaces insécables du formatage fr-FR). */
const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

export const tarifsSteps = [
  Given("un tarif de {int} € par nuit pour la villa {string}", ({ world, params }) =>
    world.use(
      Effect.map(Rates, (rates) => {
        const [rate, villa] = params as [number, string];
        rates.set(villa, rate);
      }),
    ),
  ),

  Given("{string} est connecté", ({ world, params }) => {
    const [email] = params as [string];
    world.signIn(email, `user-${email}`);
  }),

  When(
    "le client demande une réservation de {int} nuits à partir du {string}",
    ({ world, params }) => {
      const [nights, from] = params as [number, string];
      return world.use(
        Effect.gen(function* () {
          const exit = yield* world.dispatch(
            RequestReservation,
            { resourceId: "savanne", from, to: isoPlusDays(from, nights) },
            { actor: world.currentActor?.id ?? "anonymous" },
          );
          if (Exit.isSuccess(exit)) {
            world.lastReservation = exit.value;
          }
        }),
      );
    },
  ),

  Then("le total est de {string}", ({ world, params }) => {
    const [total] = params as [string];
    world.expectSuccess();
    const reservation = world.lastReservation;
    if (reservation === undefined) throw new Error("aucune réservation acceptée");
    if (norm(reservation.totalAmount) !== norm(total)) {
      throw new Error(`total attendu ${total}, obtenu ${reservation.totalAmount}`);
    }
  }),
] as const satisfies ReadonlyArray<StepDefinition<FixtureWorld>>;
