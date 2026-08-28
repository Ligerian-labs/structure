import { Effect, Schema } from "effect";
import {
  ddMmYyyyToIso,
  Given,
  registerVerifiedCustomer,
  type StepDefinition,
  signInPassword,
  Then,
  When,
} from "../../src/index.js";
import type { FixtureWorld } from "../fixture/app.js";

const profileRow = Schema.Struct({
  email: Schema.String,
  password: Schema.String,
  displayName: Schema.String,
  birthdate: Schema.String,
  referral: Schema.NullOr(Schema.String),
});

/** Registers one customer through the kit and records a profile-shaped entry. */
const registerOne = (world: FixtureWorld, row: Schema.Schema.Type<typeof profileRow>) =>
  Effect.gen(function* () {
    const id = yield* registerVerifiedCustomer({
      testAuth: world.testAuth,
      email: row.email,
      password: row.password,
      displayName: row.displayName,
    });
    world.signIn(row.email, id);
    world.registeredProfiles.push({ email: row.email, birthdateIso: ddMmYyyyToIso(row.birthdate) });
  });

export const accountSteps = [
  Given("{string} is a registered customer", ({ world, params }) => {
    const [email] = params as readonly [string];
    return registerVerifiedCustomer({
      testAuth: world.testAuth,
      email,
      password: "registered-pass-1",
    }).pipe(Effect.tap((id) => Effect.sync(() => world.signIn(email, id))));
  }),

  When("{string} registers with password {string} as {string}", ({ world, params }) => {
    const [email, password, displayName] = params as readonly [string, string, string];
    return registerVerifiedCustomer({
      testAuth: world.testAuth,
      email,
      password,
      displayName,
    }).pipe(Effect.tap((id) => Effect.sync(() => world.signIn(email, id))));
  }),

  When("{string} signs in with password {string}", ({ world, params }) => {
    const [email, password] = params as readonly [string, string];
    // Raw service call through `attempt`: the tagged auth error is recorded
    // for `Then an exception ...` exactly like a failed dispatch.
    return world.attempt(
      world.testAuth.auth.signInPassword(world.testAuth.tenantId, email, password),
    );
  }),

  When("{string} signs in with their recorded password", ({ world, params }) => {
    const [email] = params as readonly [string];
    return signInPassword({ testAuth: world.testAuth, email, password: "registered-pass-1" }).pipe(
      Effect.tap((token) => Effect.sync(() => world.sessionTokens.set(email, token))),
    );
  }),

  Given("the following customers register:", ({ world, table }) =>
    Effect.gen(function* () {
      const rows =
        table !== undefined ? yield* table.rows(profileRow, { nullLiteral: "NULL" }) : [];
      for (const row of rows) yield* registerOne(world, row);
    }).pipe(world.use),
  ),

  Then("the registration is accepted", ({ world }) => {
    if (world.currentActor === undefined) throw new Error("no actor signed in after registration");
  }),

  Then("a verification e-mail was sent to {string}", ({ world, params }) => {
    const [email] = params as readonly [string];
    const verification = world.testAuth.emails.find(
      (sent) => sent.kind === "email-verification" && sent.to === email,
    );
    if (verification === undefined) {
      throw new Error(`no verification email captured for ${email}`);
    }
  }),

  Then("{string} is signed in as the current actor", ({ world, params }) => {
    const [email] = params as readonly [string];
    if (world.currentActor?.name !== email) {
      throw new Error(`current actor is ${world.currentActor?.name ?? "none"}, expected ${email}`);
    }
  }),

  Then("{int} customers have registered profiles", ({ world, params }) => {
    const [count] = params as readonly [number];
    if (world.registeredProfiles.length !== count) {
      throw new Error(`expected ${count} profiles, found ${world.registeredProfiles.length}`);
    }
  }),

  Then("the profile of {string} records the birthdate {word}", ({ world, params }) => {
    const [email, birthdateIso] = params as readonly [string, string];
    const profile = world.registeredProfiles.find((entry) => entry.email === email);
    if (profile === undefined) throw new Error(`no profile for ${email}`);
    if (profile.birthdateIso !== birthdateIso) {
      throw new Error(`expected birthdate ${birthdateIso}, recorded ${profile.birthdateIso}`);
    }
  }),
] as const satisfies ReadonlyArray<StepDefinition<FixtureWorld>>;
