import { defineFeatureSuite } from "../src/index.js";
import { buildTestWorld, drainWorld } from "./fixture/app.js";
import { reservationSteps } from "./steps/reservations.steps.js";
import { tarifsSteps } from "./steps/tarifs.steps.js";

defineFeatureSuite({
  features: "test/features/**/*.feature",
  makeWorld: buildTestWorld,
  steps: [...reservationSteps, ...tarifsSteps],
  drain: drainWorld,
});
