import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit } from "effect";
import {
  Authorization,
  PermissionDenied,
  Policy,
  Principal,
  Unauthenticated,
} from "../src/index.js";

const policy = Policy.define({
  resources: { report: ["read", "publish"] },
  roles: {
    reader: { grants: ["report:read"] },
    editor: { inherits: ["reader"], grants: ["report:publish"] },
  },
});

const AuthorizationLive = Authorization.layer(policy);

const as = (id: string, ...roles: ReadonlyArray<string>) =>
  Principal.within({ id, roles: [...roles] });

describe("Authorization service", () => {
  test("check/can/decide/require work against the fiber's principal through the service", async () => {
    const program = Effect.gen(function* () {
      const canRead = yield* Authorization.can("report:read");
      const canPublish = yield* Authorization.can("report:publish");
      const decision = yield* Authorization.decide("report:publish");
      yield* Authorization.check("report:read");
      const guarded = yield* Effect.succeed(42).pipe(Authorization.require("report:read"));
      const role = yield* Effect.succeed("r").pipe(Authorization.requireRole("reader"));
      return { canRead, canPublish, decision, guarded, role };
    });
    const result = await Effect.runPromise(
      as("ada", "reader")(program).pipe(Effect.provide(AuthorizationLive)),
    );
    expect(result.canRead).toBe(true);
    expect(result.canPublish).toBe(false);
    expect(result.decision.reason).toBe('no role of [reader] grants "report:publish"');
    expect(result.guarded).toBe(42);
    expect(result.role).toBe("r");

    const denied = await Effect.runPromise(
      as(
        "ada",
        "reader",
      )(Effect.flip(Authorization.check("report:publish"))).pipe(Effect.provide(AuthorizationLive)),
    );
    expect(denied).toBeInstanceOf(PermissionDenied);

    const unauthenticated = await Effect.runPromise(
      Effect.flip(Authorization.check("report:read")).pipe(Effect.provide(AuthorizationLive)),
    );
    expect(unauthenticated).toBeInstanceOf(Unauthenticated);
    // decide without a principal evaluates the anonymous principal — no failure channel.
    const anonymousDecision = await Effect.runPromise(
      Authorization.decide("report:read").pipe(Effect.provide(AuthorizationLive)),
    );
    expect(anonymousDecision).toMatchObject({ allowed: false, principal: "anonymous" });
  });

  test("a permission the policy does not declare is a defect, not a denial", async () => {
    const exit = await Effect.runPromiseExit(
      as(
        "ada",
        "reader",
      )(Authorization.check("report:delete")).pipe(Effect.provide(AuthorizationLive)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.isDie(exit.cause)).toBe(true);
      expect(Cause.pretty(exit.cause)).toContain('permission "report:delete" is not declared');
    }
  });

  test("Authorization.principal is the required principal", async () => {
    const id = await Effect.runPromise(
      as("zed", "reader")(Effect.map(Authorization.principal, (p) => p.id)),
    );
    expect(id).toBe("zed");
  });
});
