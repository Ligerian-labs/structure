import { describe, expect, test } from "bun:test";
import { DomainEvent } from "@structure-ai/domain";
import { Chunk, Effect, Either, Schema, Stream } from "effect";
import {
  EventRegistry,
  EventStore,
  HistoryImport,
  HistoryImporter,
  type HistoryImportFailureReason,
  InMemoryAll,
  Outbox,
  type StoredEvent,
} from "../src/index.js";
import { Incremented } from "./fixtures.js";

const OrderPlaced = DomainEvent.define("OrderPlaced", { orderId: Schema.String });
const historyRegistry = EventRegistry.make([
  { schema: Incremented, schemaVersion: 1 },
  { schema: OrderPlaced, schemaVersion: 1 },
]);

const importedEvent = (
  position: bigint,
  streamName: string,
  version: number,
  eventId: string,
  type: "Incremented" | "OrderPlaced" = "Incremented",
): StoredEvent => ({
  position,
  streamName,
  version,
  type,
  schemaVersion: 1,
  payload:
    type === "Incremented"
      ? { _tag: "Incremented", amount: version }
      : { _tag: "OrderPlaced", orderId: streamName.slice("Order-".length) },
  metadata: {
    eventId,
    occurredAt: `2025-01-01T00:00:0${position.toString()}.000Z`,
    aggregateName: type === "Incremented" ? "Counter" : "Order",
    aggregateId:
      type === "Incremented"
        ? streamName.slice("Counter-".length)
        : streamName.slice("Order-".length),
    aggregateVersion: version,
    correlationId: "migration-1",
    causationId: `legacy-${eventId}`,
    actor: "legacy-user",
  },
});

const history = [
  importedEvent(1n, "Counter-a", 1, "event-1"),
  importedEvent(2n, "Order-b", 1, "event-2", "OrderPlaced"),
  importedEvent(3n, "Counter-a", 2, "event-3"),
] as const;

const batch = (events: ReadonlyArray<StoredEvent>, checksum: string) => ({
  importId: "legacy-store-2025-01",
  batchId: "batch-1",
  events,
  checksum,
  complete: true,
});

describe("InMemoryHistoryImporter", () => {
  test("preserves cross-context order, stream versions, and source metadata", async () => {
    const program = Effect.gen(function* () {
      const importer = yield* HistoryImporter;
      const store = yield* EventStore;
      const checksum = yield* HistoryImport.checksum(history);

      const result = yield* importer.importBatch(batch(history, checksum), historyRegistry);
      expect(result.status).toBe("imported");
      expect(result.importedCount).toBe(3);
      expect(result.lastPosition).toBe(3n);
      expect(result.complete).toBe(true);

      const all = Chunk.toReadonlyArray(yield* Stream.runCollect(store.readAll()));
      expect(all).toEqual(history);
      expect(
        all.map(({ streamName, version, position }) => [streamName, version, position]),
      ).toEqual([
        ["Counter-a", 1, 1n],
        ["Order-b", 1, 2n],
        ["Counter-a", 2, 3n],
      ]);
      expect(all[0]?.metadata.actor).toBe("legacy-user");

      yield* store.append("Counter-a", 2, [
        {
          type: history[0].type,
          schemaVersion: history[0].schemaVersion,
          payload: history[0].payload,
          metadata: { ...history[0].metadata, eventId: "event-4", aggregateVersion: 3 },
        },
      ]);
      const withLiveEvent = Chunk.toReadonlyArray(yield* Stream.runCollect(store.readAll()));
      expect(withLiveEvent.at(-1)?.position).toBe(4n);
    });

    await Effect.runPromise(program.pipe(Effect.provide(InMemoryAll)));
  });

  test("identical batch retries are no-ops and divergent retries fail", async () => {
    const program = Effect.gen(function* () {
      const importer = yield* HistoryImporter;
      const store = yield* EventStore;
      const checksum = yield* HistoryImport.checksum(history);
      const request = batch(history, checksum);
      const first = yield* importer.importBatch(request, historyRegistry);
      const retry = yield* importer.importBatch(request, historyRegistry);
      expect(retry).toEqual({ ...first, status: "unchanged" });

      const divergentEvents = [
        history[0],
        { ...history[1], payload: { _tag: "OrderPlaced", orderId: "different" } },
      ];
      const divergentChecksum = yield* HistoryImport.checksum(divergentEvents);
      const divergent = yield* Effect.either(
        importer.importBatch(batch(divergentEvents, divergentChecksum), historyRegistry),
      );
      expect(Either.isLeft(divergent)).toBe(true);
      if (Either.isLeft(divergent)) expect(divergent.left.reason).toBe("divergent-batch");

      expect(Chunk.toReadonlyArray(yield* Stream.runCollect(store.readAll()))).toEqual(history);
    });

    await Effect.runPromise(program.pipe(Effect.provide(InMemoryAll)));
  });

  test("resumes after a committed batch and rejects the wrong token without partial writes", async () => {
    const program = Effect.gen(function* () {
      const importer = yield* HistoryImporter;
      const store = yield* EventStore;
      const firstEvents = history.slice(0, 2);
      const secondEvents = history.slice(2);
      const firstChecksum = yield* HistoryImport.checksum(firstEvents);
      const first = yield* importer.importBatch(
        {
          importId: "legacy-store-2025-01",
          batchId: "batch-1",
          events: firstEvents,
          checksum: firstChecksum,
        },
        historyRegistry,
      );

      const secondChecksum = yield* HistoryImport.checksum(secondEvents);
      const wrong = yield* Effect.either(
        importer.importBatch(
          {
            importId: "legacy-store-2025-01",
            batchId: "batch-2",
            events: secondEvents,
            checksum: secondChecksum,
            resumeToken: "wrong",
            complete: true,
          },
          historyRegistry,
        ),
      );
      expect(Either.isLeft(wrong)).toBe(true);
      if (Either.isLeft(wrong)) expect(wrong.left.reason).toBe("resume-token-mismatch");
      expect(Chunk.toReadonlyArray(yield* Stream.runCollect(store.readAll()))).toEqual(firstEvents);

      yield* importer.importBatch(
        {
          importId: "legacy-store-2025-01",
          batchId: "batch-2",
          events: secondEvents,
          checksum: secondChecksum,
          resumeToken: first.resumeToken,
          complete: true,
        },
        historyRegistry,
      );
      expect(Chunk.toReadonlyArray(yield* Stream.runCollect(store.readAll()))).toEqual(history);
    });

    await Effect.runPromise(program.pipe(Effect.provide(InMemoryAll)));
  });

  test("validates checksums, gaps, duplicate ids, and registry decoding before commit", async () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly events: ReadonlyArray<StoredEvent>;
      readonly checksum?: string;
      readonly reason?: HistoryImportFailureReason;
      readonly decodeError?: boolean;
    }> = [
      { name: "checksum", events: history, checksum: "bad", reason: "checksum-mismatch" },
      {
        name: "position gap",
        events: [history[0], { ...history[1], position: 3n }],
        reason: "global-position-gap",
      },
      {
        name: "stream gap",
        events: [history[0], { ...history[2], position: 2n, version: 3 }],
        reason: "stream-version-gap",
      },
      {
        name: "duplicate id",
        events: [history[0], { ...history[1], metadata: history[0].metadata }],
        reason: "duplicate-event-id",
      },
      {
        name: "decode",
        events: [{ ...history[0], type: "Unknown" }],
        decodeError: true,
      },
    ];

    for (const item of cases) {
      const program = Effect.gen(function* () {
        const importer = yield* HistoryImporter;
        const store = yield* EventStore;
        const checksum = item.checksum ?? (yield* HistoryImport.checksum(item.events));
        const result = yield* Effect.either(
          importer.importBatch(
            {
              importId: `invalid-${item.name}`,
              batchId: "batch-1",
              events: item.events,
              checksum,
              complete: true,
            },
            historyRegistry,
          ),
        );
        expect(Either.isLeft(result)).toBe(true);
        if (
          Either.isLeft(result) &&
          !item.decodeError &&
          item.reason !== undefined &&
          result.left._tag === "HistoryImportError"
        ) {
          expect(result.left.reason).toBe(item.reason);
        }
        if (Either.isLeft(result) && item.decodeError)
          expect(result.left._tag).toBe("EventDecodeError");
        expect(Chunk.toReadonlyArray(yield* Stream.runCollect(store.readAll()))).toEqual([]);
      });
      await Effect.runPromise(program.pipe(Effect.provide(InMemoryAll)));
    }
  });

  test("refuses an unrelated non-empty target and leaves the outbox empty", async () => {
    const program = Effect.gen(function* () {
      const importer = yield* HistoryImporter;
      const store = yield* EventStore;
      const outbox = yield* Outbox;
      yield* store.append("Counter-live", 0, [
        {
          type: history[0].type,
          schemaVersion: history[0].schemaVersion,
          payload: history[0].payload,
          metadata: history[0].metadata,
        },
      ]);
      const checksum = yield* HistoryImport.checksum(history);
      const result = yield* Effect.either(
        importer.importBatch(batch(history, checksum), historyRegistry),
      );
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result) && result.left._tag === "HistoryImportError") {
        expect(result.left.reason).toBe("target-not-empty");
      }
      expect(yield* outbox.pending(10)).toEqual([]);
    });

    await Effect.runPromise(program.pipe(Effect.provide(InMemoryAll)));
  });
});
