import { Context, Effect, Layer } from "effect";
import {
  decodeRecordBatch,
  encodeRecordBatch,
  type FetchedRecord,
  type RecordToProduce,
} from "./batch.js";
import { ApiKey, type NisshiConnection, openConnection, PinnedVersion } from "./connection.js";
import {
  apiError,
  NisshiApiError,
  type NisshiConnectionError,
  NisshiTopicConfigurationError,
} from "./errors.js";
import { Reader } from "./primitives.js";

/** Kafka error codes this client interprets specially. */
const ErrorCode = {
  none: 0,
  unknownTopicOrPartition: 3,
  topicAlreadyExists: 36,
} as const;

/** One page of fetch results plus the partition high watermark (log end offset). */
export interface FetchPage {
  readonly records: ReadonlyArray<FetchedRecord>;
  /** Offset of the next record to be written — read up to `highWatermark - 1`. */
  readonly highWatermark: bigint;
}

/** The wire-level client: single broker, single partition per topic. */
export interface NisshiClientService {
  /** Creates `topic` with one partition; an existing topic is fine if it has exactly one. */
  readonly ensureTopic: (
    topic: string,
  ) => Effect.Effect<void, NisshiTopicConfigurationError | NisshiApiError | NisshiConnectionError>;
  /** Lists topic names known to the broker. */
  readonly listTopics: () => Effect.Effect<
    ReadonlyArray<string>,
    NisshiApiError | NisshiConnectionError
  >;
  /**
   * Produces `records` in one batch with acks=all; returns the base offset the
   * broker assigned. Records are ordered within the batch.
   */
  readonly produce: (
    topic: string,
    records: ReadonlyArray<RecordToProduce>,
  ) => Effect.Effect<bigint, NisshiApiError | NisshiConnectionError>;
  /**
   * Reads one page of records starting at `offset` (inclusive), up to
   * `maxBytes` of batch payload. Returns an empty page when caught up.
   */
  readonly fetch: (
    topic: string,
    offset: bigint,
    maxBytes: number,
  ) => Effect.Effect<FetchPage, NisshiApiError | NisshiConnectionError>;
  /**
   * The log end offset: the offset the *next* record will get. Note Nisshi's
   * ListOffsets(LATEST) reports the last written record's offset — this
   * method normalizes the difference (and is covered by tests).
   */
  readonly endOffset: (
    topic: string,
  ) => Effect.Effect<bigint, NisshiApiError | NisshiConnectionError>;
}

/** Service tag for the Nisshi wire client. */
export class NisshiClient extends Context.Tag("@structure-ai/eventsourcing-nisshi/NisshiClient")<
  NisshiClient,
  NisshiClientService
>() {}

const make = (brokerUrl: string, clientId: string, timeoutMillis: number) =>
  Effect.gen(function* () {
    const connection: NisshiConnection = yield* openConnection(brokerUrl, clientId);
    const { request } = connection;

    const partitionCount = (topic: string) =>
      Effect.map(
        request(
          ApiKey.metadata,
          PinnedVersion.metadata,
          (w) => {
            w.i32(1); // one requested topic
            w.str(topic);
          },
          timeoutMillis,
        ),
        (body): number => {
          const r = new Reader(body);
          const brokers = r.i32();
          for (let i = 0; i < brokers; i++) {
            r.i32();
            r.str();
            r.i32();
          }
          const topics = r.i32();
          for (let i = 0; i < topics; i++) {
            const errorCode = r.i16();
            const name = r.str();
            const partitions = r.i32();
            const count = partitions;
            for (let p = 0; p < partitions; p++) {
              r.i16(); // partition_error_code
              r.i32(); // partition_id
              r.i32(); // leader_id
              const replicas = r.i32();
              r.pos += replicas * 4;
              const isr = r.i32();
              r.pos += isr * 4;
            }
            if (errorCode === ErrorCode.none && name === topic) {
              return count;
            }
          }
          return -1;
        },
      );

    const ensureTopic: NisshiClientService["ensureTopic"] = (topic) =>
      Effect.gen(function* () {
        // Create FIRST, verify second: requesting Metadata for an unknown
        // topic makes Nisshi auto-create it — with FOUR partitions. Never
        // probe for a topic that may not exist.
        const body = yield* request(
          ApiKey.createTopics,
          PinnedVersion.createTopics,
          (w) => {
            w.i32(1); // one topic
            w.str(topic);
            w.i32(1); // num_partitions
            w.i16(1); // replication_factor
            w.i32(0); // assignments
            w.i32(0); // configs
            w.i32(timeoutMillis); // timeout
            w.i8(0); // validate_only = false
          },
          timeoutMillis,
        );
        const r = new Reader(body);
        // Nisshi's CreateTopics v4 response leads with throttle_time_ms.
        r.i32(); // throttle_time_ms
        const count = r.i32();
        for (let i = 0; i < count; i++) {
          const name = r.str();
          const code = r.i16();
          r.str(); // message
          if (name === topic && code !== ErrorCode.none && code !== ErrorCode.topicAlreadyExists) {
            return yield* Effect.fail(
              apiError(code, `CreateTopics(${topic}) failed with code ${code}`),
            );
          }
        }
        const created = yield* partitionCount(topic);
        if (created !== 1) {
          return yield* Effect.fail(
            new NisshiTopicConfigurationError({
              topic,
              reason: `topic reports ${created} partitions; the single-partition contract requires exactly 1 (see ADR-0015)`,
            }),
          );
        }
      });

    const listTopics: NisshiClientService["listTopics"] = () =>
      Effect.map(
        request(
          ApiKey.metadata,
          PinnedVersion.metadata,
          (w) => {
            w.i32(-1); // all topics
          },
          timeoutMillis,
        ),
        (body): ReadonlyArray<string> => {
          const r = new Reader(body);
          const brokers = r.i32();
          for (let i = 0; i < brokers; i++) {
            r.i32();
            r.str();
            r.i32();
          }
          const topics = r.i32();
          const names: string[] = [];
          for (let i = 0; i < topics; i++) {
            const errorCode = r.i16();
            const name = r.str() ?? "?";
            const partitions = r.i32();
            for (let p = 0; p < partitions; p++) {
              r.i16(); // partition_error_code
              r.i32(); // partition_id
              r.i32(); // leader_id
              const replicas = r.i32();
              r.pos += replicas * 4;
              const isr = r.i32();
              r.pos += isr * 4;
            }
            if (errorCode === ErrorCode.none) {
              names.push(name);
            }
          }
          return names;
        },
      );

    const produce: NisshiClientService["produce"] = (topic, records) =>
      Effect.gen(function* () {
        const batch = encodeRecordBatch(records);
        const body = yield* request(
          ApiKey.produce,
          PinnedVersion.produce,
          (w) => {
            w.str(null); // transactional id
            w.i16(-1); // acks = all
            w.i32(timeoutMillis);
            w.i32(1); // one topic
            w.str(topic);
            w.i32(1); // one partition
            w.i32(0); // partition 0 — single-partition contract
            w.bytes(batch);
          },
          timeoutMillis,
        );
        // Produce v3 response: [topics [partitions]] then trailing throttle.
        const r = new Reader(body);
        const topics = r.i32();
        for (let i = 0; i < topics; i++) {
          const name = r.str();
          const partitions = r.i32();
          for (let p = 0; p < partitions; p++) {
            r.i32(); // partition index
            const code = r.i16();
            const baseOffset = r.i64();
            r.i64(); // log_append_time
            if (name === topic) {
              if (code !== ErrorCode.none) {
                return yield* Effect.fail(
                  apiError(code, `Produce(${topic}) failed with code ${code}`),
                );
              }
              return baseOffset;
            }
          }
        }
        return yield* Effect.fail(
          new NisshiApiError({
            code: -1,
            message: `Produce(${topic}): no partition in response`,
            retriable: true,
          }),
        );
      });

    const fetch: NisshiClientService["fetch"] = (topic, offset, maxBytes) =>
      Effect.gen(function* () {
        const body = yield* request(
          ApiKey.fetch,
          PinnedVersion.fetch,
          (w) => {
            w.i32(-1); // replica id
            w.i32(250); // max wait (ms)
            w.i32(1); // min bytes
            w.i32(maxBytes); // max bytes
            w.i8(0); // isolation level
            w.i32(1); // one topic
            w.str(topic);
            w.i32(1); // one partition
            w.i32(0); // partition 0
            w.i64(offset);
            w.i32(maxBytes);
          },
          timeoutMillis,
        );
        // Fetch v4 response: throttle, [topics [partitions]], records last.
        const r = new Reader(body);
        r.i32(); // throttle_time_ms
        const topics = r.i32();
        for (let i = 0; i < topics; i++) {
          const name = r.str();
          const partitions = r.i32();
          for (let p = 0; p < partitions; p++) {
            r.i32(); // partition index
            const code = r.i16();
            const highWatermark = r.i64();
            r.i64(); // last stable offset
            const aborted = r.i32();
            if (aborted > 0) {
              for (let a = 0; a < aborted; a++) {
                r.i64();
                r.i32();
              }
            }
            const records = r.bytes();
            if (name !== topic) {
              continue;
            }
            if (code === ErrorCode.unknownTopicOrPartition) {
              return { records: [], highWatermark: 0n };
            }
            if (code !== ErrorCode.none) {
              return yield* Effect.fail(apiError(code, `Fetch(${topic}) failed with code ${code}`));
            }
            // Kafka returns the WHOLE batch containing the requested offset;
            // drop the leading records below it.
            const decoded = records === null ? [] : decodeRecordBatch(records);
            return {
              highWatermark,
              records: decoded.filter((record) => record.offset >= offset),
            };
          }
        }
        return { records: [], highWatermark: 0n };
      });

    const endOffset: NisshiClientService["endOffset"] = (topic) =>
      Effect.map(fetch(topic, 0n, 1), (page) =>
        // An empty partition reports a high watermark of 1 on Nisshi — treat
        // "no records at offset 0" as the true log end (0).
        page.records.length === 0 ? 0n : page.highWatermark,
      );

    return { ensureTopic, listTopics, produce, fetch, endOffset } satisfies NisshiClientService;
  });

/** Layer over one broker connection; the socket closes with the layer scope. */
export const nisshiClientLayer = (options: {
  readonly brokerUrl: string;
  readonly clientId?: string | undefined;
  readonly timeoutMillis?: number | undefined;
}): Layer.Layer<NisshiClient, NisshiConnectionError> =>
  Layer.scoped(
    NisshiClient,
    make(
      options.brokerUrl,
      options.clientId ?? "structure-nisshi",
      options.timeoutMillis ?? 10_000,
    ),
  );
