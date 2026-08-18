import { describe, expect, test } from "bun:test";
import { DomainEvent } from "@structure-ai/domain";
import { Effect, Either, Schema } from "effect";
import { EventRegistry } from "../src/index.js";

const UserRenamed = DomainEvent.define("UserRenamed", { name: Schema.String });

interface RenamedV1 {
  readonly _tag: string;
  readonly oldName: string;
}

const registry = EventRegistry.make([
  {
    schema: UserRenamed,
    schemaVersion: 2,
    upcasters: {
      1: (payload) => {
        const v1 = payload as RenamedV1;
        return { _tag: v1._tag, name: v1.oldName };
      },
    },
  },
]);

describe("EventRegistry", () => {
  test("encode stamps the current schema version and a JSON payload", () => {
    const serialized = registry.encode(UserRenamed.make({ name: "Ada" }));
    expect(serialized.type).toBe("UserRenamed");
    expect(serialized.schemaVersion).toBe(2);
    expect(serialized.payload).toEqual({ _tag: "UserRenamed", name: "Ada" });
  });

  test("decode upcasts a v1 payload to the current v2 schema", async () => {
    const decoded = await Effect.runPromise(
      registry.decode({
        type: "UserRenamed",
        schemaVersion: 1,
        payload: { _tag: "UserRenamed", oldName: "Ada" },
      }),
    );
    expect(decoded._tag).toBe("UserRenamed");
    expect(decoded.name).toBe("Ada");
  });

  test("decode roundtrips a current-version payload", async () => {
    const decoded = await Effect.runPromise(
      registry.decode(registry.encode(UserRenamed.make({ name: "Grace" }))),
    );
    expect(decoded.name).toBe("Grace");
  });

  test("unknown type and invalid payload fail with EventDecodeError", async () => {
    const unknownType = await Effect.runPromise(
      Effect.either(registry.decode({ type: "Nope", schemaVersion: 1, payload: {} })),
    );
    expect(Either.isLeft(unknownType)).toBe(true);
    if (Either.isLeft(unknownType)) {
      expect(unknownType.left._tag).toBe("EventDecodeError");
      expect(unknownType.left.classification).toBe("permanent");
    }
    const badPayload = await Effect.runPromise(
      Effect.either(
        registry.decode({
          type: "UserRenamed",
          schemaVersion: 2,
          payload: { _tag: "UserRenamed", name: 42 },
        }),
      ),
    );
    expect(Either.isLeft(badPayload)).toBe(true);
  });
});
