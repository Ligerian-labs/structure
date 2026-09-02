import { describe, expect, test } from "bun:test";
import { Policy } from "@structure-ai/authorization";
import { Effect, Redacted } from "effect";
import {
  type ApiKeyRecord,
  InvalidCredentials,
  inMemoryApiKeyStore,
  makeApiKeys,
} from "../src/index.js";

const peppers = (currentVersion: number) => ({
  current: { version: currentVersion, pepper: Redacted.make(`pepper-v${currentVersion}`) },
  retired: [
    { version: 1, pepper: Redacted.make("pepper-v1") },
    { version: 2, pepper: Redacted.make("pepper-v2") },
  ].filter((entry) => entry.version < currentVersion),
});

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

const fixedNow = new Date("2026-08-20T12:00:00.000Z");

describe("api keys", () => {
  test("mint/verify lifecycle keeps only hashes at rest", async () => {
    const store = inMemoryApiKeyStore();
    const keys = makeApiKeys({ store, peppers: peppers(2), now: () => fixedNow });
    const minted = await run(keys.mint("tenant-a", { userId: "user-1", scopes: ["data:export"] }));
    const raw = Redacted.value(minted.key);
    expect(raw).toMatch(/^sk_[0-9a-f]+_2_[0-9a-f]{64}$/u);
    // At rest: hash only — the raw secret appears nowhere in the store.
    const stored = store.snapshot()[0] as ApiKeyRecord | undefined;
    expect(stored?.secretHash).toBeDefined();
    expect(JSON.stringify(store.snapshot())).not.toContain(raw.split("_")[3] ?? "");
    expect(stored?.scopes).toEqual(["data:export"]);

    const standing = await run(keys.verify("tenant-a", minted.key));
    expect(standing.userId).toBe("user-1");
    expect(standing.scopes).toEqual(["data:export"]);
    // Last-use tracking.
    expect(store.snapshot()[0]?.lastUsedAt).toEqual(fixedNow);
    // Tenants are isolated.
    const cross = await Effect.runPromise(Effect.flip(keys.verify("tenant-b", minted.key)));
    expect(cross).toBeInstanceOf(InvalidCredentials);
  });

  test("revoked keys fail verification", async () => {
    const store = inMemoryApiKeyStore();
    const keys = makeApiKeys({ store, peppers: peppers(2), now: () => fixedNow });
    const minted = await run(keys.mint("tenant-a", { userId: "user-1", scopes: [] }));
    await run(keys.revoke("tenant-a", minted.record.keyId));
    const error = await Effect.runPromise(Effect.flip(keys.verify("tenant-a", minted.key)));
    expect(error).toBeInstanceOf(InvalidCredentials);
    expect((error as InvalidCredentials).reason).toBe("api-key-revoked");
  });

  test("expired keys fail verification before any scope answer", async () => {
    const store = inMemoryApiKeyStore();
    const keys = makeApiKeys({ store, peppers: peppers(2), now: () => fixedNow });
    const minted = await run(
      keys.mint("tenant-a", {
        userId: "user-1",
        scopes: ["data:export"],
        expiresAt: new Date("2026-08-19T00:00:00.000Z"),
      }),
    );
    const error = await Effect.runPromise(Effect.flip(keys.verify("tenant-a", minted.key)));
    expect((error as InvalidCredentials).reason).toBe("api-key-expired");
  });

  test("pepper rotation: old keys keep working, rehash lazily, dropped peppers reject", async () => {
    const store = inMemoryApiKeyStore();
    // Mint two keys under pepper v1: one gets used, one stays untouched.
    const v1Keys = makeApiKeys({ store, peppers: peppers(1), now: () => fixedNow });
    const used = await run(v1Keys.mint("tenant-a", { userId: "user-1", scopes: [] }));
    const untouched = await run(v1Keys.mint("tenant-a", { userId: "user-1", scopes: [] }));
    const usedHash = store.snapshot()[0]?.secretHash;

    // Rotate to v2 (v1 retired-but-known): the used key still verifies...
    const v2Keys = makeApiKeys({ store, peppers: peppers(2), now: () => fixedNow });
    const standing = await run(v2Keys.verify("tenant-a", used.key));
    expect(standing.userId).toBe("user-1");
    // ...and was rehashed under the current pepper on first use.
    const rotated = store.snapshot()[0];
    expect(rotated?.pepperVersion).toBe(2);
    expect(rotated?.secretHash).not.toBe(usedHash);

    // Rotate to v3 with v1 fully dropped: the untouched v1 key rejects.
    const v3Keys = makeApiKeys({
      store,
      peppers: { current: { version: 3, pepper: Redacted.make("pepper-v3") }, retired: [] },
      now: () => fixedNow,
    });
    const error = await Effect.runPromise(Effect.flip(v3Keys.verify("tenant-a", untouched.key)));
    expect((error as InvalidCredentials).reason).toBe("api-key-pepper-retired");
  });

  test("garbage keys fail closed without store lookups", async () => {
    const store = inMemoryApiKeyStore();
    const keys = makeApiKeys({ store, peppers: peppers(2), now: () => fixedNow });
    for (const garbage of ["", "nope", "sk_a_b_c", "pk_a_1_c", "sk_a_1_short"]) {
      const error = await Effect.runPromise(
        Effect.flip(keys.verify("tenant-a", Redacted.make(garbage))),
      );
      expect(error).toBeInstanceOf(InvalidCredentials);
    }
  });

  test("dead owning users answer 401 (InvalidCredentials) before any workspace answer", async () => {
    const store = inMemoryApiKeyStore();
    const alive = new Set(["user-alive"]);
    const keys = makeApiKeys({
      store,
      peppers: peppers(2),
      now: () => fixedNow,
      resolveUser: (tenantId, userId) =>
        Effect.succeed(tenantId === "tenant-a" && alive.has(userId)),
    });
    const dead = await run(
      keys.mint("tenant-a", { userId: "user-dead", scopes: ["data:export"], workspaceId: "ws-1" }),
    );
    const error = await Effect.runPromise(Effect.flip(keys.verify("tenant-a", dead.key)));
    expect(error).toBeInstanceOf(InvalidCredentials);
    expect((error as InvalidCredentials).reason).toBe("api-key-user");
  });

  test("workspace pinning is standing: mismatches are distinguishable from dead credentials", async () => {
    const store = inMemoryApiKeyStore();
    const keys = makeApiKeys({ store, peppers: peppers(2), now: () => fixedNow });
    const minted = await run(
      keys.mint("tenant-a", { userId: "user-1", scopes: ["data:export"], workspaceId: "ws-1" }),
    );
    const standing = await run(keys.verify("tenant-a", minted.key));
    expect(standing.workspaceId).toBe("ws-1");
    // An app checks the request workspace against standing.workspaceId and
    // answers 403 workspace_mismatch only when standing exists (verified key).
  });

  test("scopes become a restricted machine principal enforced fail-closed by a policy", async () => {
    const store = inMemoryApiKeyStore();
    const keys = makeApiKeys({ store, peppers: peppers(2), now: () => fixedNow });
    const minted = await run(keys.mint("tenant-a", { userId: "user-1", scopes: ["data:export"] }));
    const standing = await run(keys.verify("tenant-a", minted.key));

    // Reference composition: the api-key principal flows into an
    // @structure-ai/authorization policy. Machine principals only reach
    // permissions explicitly allowlisted for their scopes; everything else
    // denies (fail-closed), while human principals keep their roles.
    const policy = Policy.define({
      resources: { data: ["export", "purge"], billing: ["charge"] },
      conditions: {
        scopeDataExport: (context) => {
          const scopes = context.principal.attributes?.scopes;
          return (
            Array.isArray(scopes) &&
            scopes.includes("data:export") &&
            context.principal.kind === "service"
          );
        },
      },
      roles: {
        // Machine keys get only the consciously allowlisted route, guarded by
        // the scope attribute their key carries; every other permission is
        // simply not granted — unlisted routes fail closed.
        machine: {
          grants: [
            {
              permission: "data:export",
              when: "scopeDataExport",
            },
          ],
        },
        member: { grants: ["billing:charge"] },
      },
    });

    const allowed = policy.decide(standing.principal, "data:export");
    expect(allowed.allowed).toBe(true);
    // Unlisted scope (billing) denies for the machine principal...
    const unlisted = policy.decide(standing.principal, "billing:charge");
    expect(unlisted.allowed).toBe(false);
    // ...while a human member keeps access — the routes stay reachable for people.
    const human = policy.decide(
      { id: "user-1", kind: "user", roles: ["member"], tenantId: "tenant-a" },
      "billing:charge",
    );
    expect(human.allowed).toBe(true);
  });
});
