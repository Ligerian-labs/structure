import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as HttpServer from "@effect/platform/HttpServer";
import {
  Authorizer,
  CommandBus,
  HandlerRegistry,
  IdempotencyStore,
  QueryBus,
} from "@structure-ai/cqrs";
import { InMemoryAll } from "@structure-ai/eventsourcing";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { RecordingAuth, TestControl } from "../src/index.js";

// The auth seeding composition: the real AuthService over the recording
// sender (the same composition an app's e2e-main builds with RecordingAuth).

const auth = RecordingAuth.make({
  tenantId: "fixture",
  baseUrl: new URL("http://127.0.0.1:3100"),
});

const Live = TestControl.layer({
  port: 0,
  token: "auth-seed-token",
  auth: { tenantId: auth.tenantId, service: auth.auth, emails: auth.emails },
}).pipe(
  // The control plane requires both buses; this composition registers no
  // messages, only seeds auth.
  Layer.provide(
    Layer.mergeAll(CommandBus.layer, QueryBus.layer).pipe(
      Layer.provide(HandlerRegistry.layer()),
      Layer.provide(Authorizer.allowAll),
      Layer.provide(IdempotencyStore.inMemory),
    ),
  ),
  Layer.provideMerge(InMemoryAll),
);

const scope = Effect.runSync(Scope.make());
let baseUrl = "";

beforeAll(async () => {
  const context = await Effect.runPromise(Layer.buildWithScope(Live, scope));
  const address = Context.get(context, HttpServer.HttpServer).address;
  if (address._tag !== "TcpAddress") throw new Error("expected a tcp address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void));
});

describe("auth seeding", () => {
  test("registers, completes verification, and returns the user id", async () => {
    const response = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { authorization: "Bearer auth-seed-token", "content-type": "application/json" },
      body: JSON.stringify({
        email: "ada@example.test",
        password: "correct horse battery staple",
        displayName: "Ada",
      }),
    });
    expect(response.status).toBe(200);
    const exit = (await response.json()) as { ok: boolean; value?: { userId: string } };
    expect(exit.ok).toBe(true);
    expect(exit.value?.userId).toBeTruthy();
  });

  test("the seeded user signs in with the real service", async () => {
    const session = await Effect.runPromise(
      auth.auth.signInPassword("fixture", "ada@example.test", "correct horse battery staple"),
    );
    expect(session.user.email).toBe("ada@example.test");
  });

  test("the verification e-mail was captured once", () => {
    const verifications = auth.emails.filter(
      (email) => email.kind === "email-verification" && email.to === "ada@example.test",
    );
    expect(verifications.length).toBe(1);
  });
});
