import { expect, test } from "bun:test";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import { NotFound } from "@structure-ai/domain";
import { Cause, Effect, Exit, FiberId } from "effect";
import { Middleware } from "../src/index.js";

const missing = new NotFound({ entity: "Thing", id: "1" });
test("a business failure cannot hide a defect in the same cause", async () => {
  const response = await Effect.runPromise(
    Effect.provideService(
      Middleware.problems(
        Effect.failCause(
          Cause.parallel(Cause.fail(missing), Cause.die(new Error("private database detail"))),
        ),
      ),
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(new Request("http://localhost/")),
    ),
  );
  expect(response.status).toBe(500);
});
test("a business failure cannot hide interruption in the same cause", async () => {
  const cause = Cause.parallel(Cause.fail(missing), Cause.interrupt(FiberId.none));
  const exit = await Effect.runPromiseExit(
    Effect.provideService(
      Middleware.problems(Effect.failCause(cause)),
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(new Request("http://localhost/")),
    ),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) expect(exit.cause).toEqual(cause);
});
test("a defect carrying a business error remains a server error", async () => {
  const response = await Effect.runPromise(
    Effect.provideService(
      Middleware.problems(Effect.die(missing)),
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(new Request("http://localhost/")),
    ),
  );
  expect(response.status).toBe(500);
});

test("a matching tag without the error contract is not a framework failure", async () => {
  const { toProblem, problemStatus } = await import("../src/index.js");
  for (const error of [
    { _tag: "NotFound", entity: 12, id: "1" },
    { _tag: "ValidationFailed", issues: "private details" },
    { _tag: "RouteNotFound" },
    { _tag: "HttpApiDecodeError", issues: [] },
  ]) {
    expect(problemStatus(toProblem(error))).toBe(500);
  }
});
