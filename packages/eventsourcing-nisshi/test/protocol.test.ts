/**
 * Wire-protocol tests against a live Nisshi broker. Skipped unless
 * `NISSHI_URL` is set (CI installs a pinned binary and exports it).
 */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  NisshiClient,
  type NisshiTopicConfigurationError,
  nisshiClientLayer,
  openConnection,
  PinnedVersion,
} from "../src/index.js";
import { counterRegistry, testMetadata } from "./fixtures.js";

const brokerUrl = process.env.NISSHI_URL ?? "";
const maybe = brokerUrl === "" ? describe.skip : describe;

const clientLayer = nisshiClientLayer({ brokerUrl });

maybe("nisshi wire protocol", () => {
  const uniqueTopic = (): string => `proto_${crypto.randomUUID().replaceAll("-", "_")}`;

  test("handshake pins supported versions", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* openConnection(brokerUrl, "proto-test");
          for (const [name, key, pinned] of [
            ["Produce", 0, PinnedVersion.produce],
            ["Fetch", 1, PinnedVersion.fetch],
            ["CreateTopics", 19, PinnedVersion.createTopics],
          ] as const) {
            const range = connection.versions.get(key);
            expect(range, name).toBeDefined();
            if (range !== undefined) {
              expect(pinned).toBeGreaterThanOrEqual(range[0]);
              expect(pinned).toBeLessThanOrEqual(range[1]);
            }
          }
        }),
      ),
    ));

  test("produce then fetch round-trips records in order", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const topic = uniqueTopic();
        const client = yield* NisshiClient;
        yield* client.ensureTopic(topic);
        const enc = new TextEncoder();
        const base = yield* client.produce(topic, [
          { key: enc.encode("a-1"), value: enc.encode("one") },
          { key: enc.encode("a-1"), value: enc.encode("two") },
          { key: enc.encode("b-2"), value: enc.encode("three") },
        ]);
        expect(base).toBe(0n);
        const page = yield* client.fetch(topic, 0n, 1024 * 1024);
        expect(page.records.map((r) => new TextDecoder().decode(r.value))).toEqual([
          "one",
          "two",
          "three",
        ]);
        expect(page.highWatermark).toBe(3n);
        // positioned read from the middle
        const tail = yield* client.fetch(topic, 2n, 1024 * 1024);
        expect(tail.records.map((r) => r.offset)).toEqual([2n]);
        // caught-up read is empty
        const end = yield* client.fetch(topic, 3n, 1024 * 1024);
        expect(end.records.length).toBe(0);
      }).pipe(Effect.provide(clientLayer)),
    ));

  test("endOffset reports the log end (0 when empty, n after n records)", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const topic = uniqueTopic();
        const client = yield* NisshiClient;
        yield* client.ensureTopic(topic);
        expect(yield* client.endOffset(topic)).toBe(0n);
        yield* client.produce(topic, [{ key: null, value: new TextEncoder().encode("x") }]);
        yield* client.produce(topic, [{ key: null, value: new TextEncoder().encode("y") }]);
        expect(yield* client.endOffset(topic)).toBe(2n);
      }).pipe(Effect.provide(clientLayer)),
    ));

  test("ensureTopic is idempotent and rejects multi-partition topics", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const topic = uniqueTopic();
          const client = yield* NisshiClient;
          yield* client.ensureTopic(topic);
          yield* client.ensureTopic(topic); // no error, no duplicate

          // A topic with two partitions violates the single-partition contract.
          const wide = `${topic}_wide`;
          const connection = yield* openConnection(brokerUrl, "proto-test");
          yield* connection.request(
            19,
            PinnedVersion.createTopics,
            (w) => {
              w.i32(1);
              w.str(wide);
              w.i32(2); // num_partitions = 2
              w.i16(1);
              w.i32(0);
              w.i32(0);
              w.i32(5000);
              w.i8(0);
            },
            5000,
          );
          const failure = yield* Effect.flip(client.ensureTopic(wide));
          expect(failure._tag).toBe("NisshiTopicConfigurationError");
          expect((failure as NisshiTopicConfigurationError).topic).toBe(wide);
        }).pipe(Effect.provide(clientLayer)),
      ),
    ));

  test("listTopics sees created topics", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const topic = uniqueTopic();
        const client = yield* NisshiClient;
        yield* client.ensureTopic(topic);
        const topics = yield* client.listTopics();
        expect(topics).toContain(topic);
      }).pipe(Effect.provide(clientLayer)),
    ));

  test("metadata round trip via registry codec (sanity)", () => {
    const event = { _tag: "Incremented" as const, amount: 7 };
    const encoded = counterRegistry.encode(event);
    expect(encoded.type).toBe("Incremented");
    expect(encoded.schemaVersion).toBe(1);
    expect(testMetadata(1).aggregateVersion).toBe(1);
  });
});
