import { EventMetadata } from "@structure-ai/domain";
import { Context, Data, Effect, Schema } from "effect";
import type { EventDecodeError, SerializedEvent } from "./codec.js";
import type { StoredEvent } from "./EventStore.js";

/** Payload decoder used to reject unknown or invalid imported events before writing. */
export interface HistoryEventDecoder {
  readonly decode: (event: SerializedEvent) => Effect.Effect<unknown, EventDecodeError>;
}

/** One retryable, ordered part of a frozen event-store history. */
export interface HistoryImportBatch {
  /** Stable identity of the complete source-store import. */
  readonly importId: string;
  /** Stable identity of this batch within the import. */
  readonly batchId: string;
  /** Events in exact source global-position order. */
  readonly events: ReadonlyArray<StoredEvent>;
  /** SHA-256 returned by `HistoryImport.checksum(events)`. */
  readonly checksum: string;
  /** Token returned by the preceding batch. Omit for the first batch. */
  readonly resumeToken?: string;
  /** Closes the import after this batch. No later batches are accepted. */
  readonly complete?: boolean;
}

/** Result of a committed batch or an identical retry. */
export interface HistoryImportResult {
  readonly status: "imported" | "unchanged";
  readonly importedCount: number;
  readonly lastPosition: bigint;
  readonly resumeToken: string;
  readonly complete: boolean;
}

export type HistoryImportFailureReason =
  | "invalid-import-id"
  | "invalid-batch-id"
  | "checksum-mismatch"
  | "invalid-position"
  | "global-position-gap"
  | "stream-version-gap"
  | "duplicate-event-id"
  | "invalid-metadata"
  | "target-not-empty"
  | "resume-token-mismatch"
  | "divergent-batch"
  | "import-complete";

/** A frozen history batch is invalid or conflicts with import state already committed. */
export class HistoryImportError extends Data.TaggedError("HistoryImportError")<{
  readonly reason: HistoryImportFailureReason;
  readonly detail: string;
}> {
  readonly classification: "permanent" | "conflict" =
    this.reason === "target-not-empty" ||
    this.reason === "resume-token-mismatch" ||
    this.reason === "divergent-batch" ||
    this.reason === "import-complete"
      ? "conflict"
      : "permanent";
  override get message(): string {
    return `history import ${this.reason}: ${this.detail}`;
  }
}

const failure = (reason: HistoryImportFailureReason, detail: string): HistoryImportError =>
  new HistoryImportError({ reason, detail });

/** Resumable frozen-history import port. Each batch commits atomically. */
export interface HistoryImporterService {
  readonly importBatch: (
    batch: HistoryImportBatch,
    decoder: HistoryEventDecoder,
  ) => Effect.Effect<HistoryImportResult, HistoryImportError | EventDecodeError>;
}

/** Service tag for resumable frozen-history import. */
export class HistoryImporter extends Context.Tag("@structure-ai/eventsourcing/HistoryImporter")<
  HistoryImporter,
  HistoryImporterService
>() {}

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  const source = value as Readonly<Record<string, unknown>>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const member = source[key];
    if (member !== undefined) sorted[key] = canonical(member);
  }
  return sorted;
};

const stableJson = (value: unknown): string =>
  JSON.stringify(canonical(value), (_key, member: unknown) =>
    typeof member === "bigint" ? member.toString() : member,
  ) ?? "null";

const sha256Hex = (text: string): Effect.Effect<string> =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).pipe(
    Effect.map((digest) =>
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    ),
  );

const checksum = (events: ReadonlyArray<StoredEvent>): Effect.Effect<string> =>
  sha256Hex(stableJson(events));

const eventId = (event: StoredEvent): string => event.metadata.eventId;
const maxPgInteger = 2_147_483_647;
const maxPgBigInt = 9_223_372_036_854_775_807n;

/** @internal Validates a batch without observing or changing adapter state. */
export const prepareHistoryImportBatch = (
  batch: HistoryImportBatch,
  decoder: HistoryEventDecoder,
): Effect.Effect<ReadonlySet<string>, HistoryImportError | EventDecodeError> =>
  Effect.gen(function* () {
    if (batch.importId.trim() === "") {
      return yield* failure("invalid-import-id", "importId must not be empty");
    }
    if (batch.batchId.trim() === "") {
      return yield* failure("invalid-batch-id", "batchId must not be empty");
    }
    if (batch.events.length === 0) {
      return yield* failure("invalid-position", "a history import batch must contain events");
    }
    const actualChecksum = yield* checksum(batch.events);
    if (actualChecksum !== batch.checksum) {
      return yield* failure(
        "checksum-mismatch",
        `batch ${batch.batchId} checksum does not match its events`,
      );
    }

    const ids = new Set<string>();
    const versions = new Map<string, number>();
    let previousPosition: bigint | undefined;
    for (const event of batch.events) {
      if (event.streamName.trim() === "") {
        return yield* failure("stream-version-gap", "stream names must not be empty");
      }
      if (event.position < 1n || event.position > maxPgBigInt) {
        return yield* failure(
          "invalid-position",
          `global positions must be between 1 and ${maxPgBigInt.toString()}`,
        );
      }
      if (previousPosition !== undefined && event.position !== previousPosition + 1n) {
        return yield* failure(
          "global-position-gap",
          `position ${event.position.toString()} does not follow ${previousPosition.toString()}`,
        );
      }
      if (
        !Number.isSafeInteger(event.version) ||
        event.version < 1 ||
        event.version > maxPgInteger
      ) {
        return yield* failure(
          "stream-version-gap",
          `stream ${event.streamName} has invalid version ${event.version}`,
        );
      }
      if (
        !Number.isSafeInteger(event.schemaVersion) ||
        event.schemaVersion < 1 ||
        event.schemaVersion > maxPgInteger
      ) {
        return yield* failure(
          "invalid-metadata",
          `event at position ${event.position.toString()} has invalid schema version ${event.schemaVersion}`,
        );
      }
      const previousVersion = versions.get(event.streamName);
      if (previousVersion !== undefined && event.version !== previousVersion + 1) {
        return yield* failure(
          "stream-version-gap",
          `stream ${event.streamName} version ${event.version} does not follow ${previousVersion}`,
        );
      }
      const decodedMetadata = yield* Schema.decodeUnknown(EventMetadata)(event.metadata).pipe(
        Effect.mapError(() =>
          failure(
            "invalid-metadata",
            `event at position ${event.position.toString()} has invalid metadata`,
          ),
        ),
      );
      if (decodedMetadata.aggregateVersion !== event.version) {
        return yield* failure(
          "invalid-metadata",
          `event at position ${event.position.toString()} metadata version does not match stream version`,
        );
      }
      const id = eventId(event);
      if (id.trim() === "" || ids.has(id)) {
        return yield* failure(
          "duplicate-event-id",
          `event id ${id === "" ? "<empty>" : id} is duplicated or empty`,
        );
      }
      yield* decoder.decode(event);
      ids.add(id);
      versions.set(event.streamName, event.version);
      previousPosition = event.position;
    }
    return ids;
  });

/** Minimal target state needed to validate the next import batch. */
export interface HistoryImportTarget {
  readonly lastPosition: bigint;
  readonly streamVersions: ReadonlyMap<string, number>;
  readonly eventIds: ReadonlySet<string>;
}

/** @internal Builds validation state from an in-memory history. */
export const historyImportTarget = (existing: ReadonlyArray<StoredEvent>): HistoryImportTarget => {
  const streamVersions = new Map<string, number>();
  for (const event of existing) streamVersions.set(event.streamName, event.version);
  return {
    lastPosition: existing.at(-1)?.position ?? 0n,
    streamVersions,
    eventIds: new Set(existing.map(eventId)),
  };
};

/** @internal Validates a new batch against the exact history already in the target. */
export const validateHistoryImportContinuation = (
  events: ReadonlyArray<StoredEvent>,
  target: HistoryImportTarget,
): Effect.Effect<void, HistoryImportError> =>
  Effect.gen(function* () {
    const existingIds = new Set(target.eventIds);
    const versions = new Map(target.streamVersions);
    let position = target.lastPosition;
    for (const event of events) {
      if (event.position !== position + 1n) {
        return yield* failure(
          "global-position-gap",
          `position ${event.position.toString()} does not follow target position ${position.toString()}`,
        );
      }
      const currentVersion = versions.get(event.streamName) ?? 0;
      if (event.version !== currentVersion + 1) {
        return yield* failure(
          "stream-version-gap",
          `stream ${event.streamName} version ${event.version} does not follow target version ${currentVersion}`,
        );
      }
      const id = eventId(event);
      if (existingIds.has(id)) {
        return yield* failure("duplicate-event-id", `event id ${id} already exists in the target`);
      }
      existingIds.add(id);
      versions.set(event.streamName, event.version);
      position = event.position;
    }
  });

/** @internal Constructs a conflict error consistently across adapters. */
export const historyImportConflict = (
  reason: Extract<
    HistoryImportFailureReason,
    "target-not-empty" | "resume-token-mismatch" | "divergent-batch" | "import-complete"
  >,
  detail: string,
): HistoryImportError => failure(reason, detail);

/** @internal Adapter helper. Resume tokens are consistency markers, not credentials. */
export const historyImportResumeToken = (
  batch: HistoryImportBatch,
  lastPosition: bigint,
): Effect.Effect<string> =>
  sha256Hex(
    stableJson({
      importId: batch.importId,
      batchId: batch.batchId,
      checksum: batch.checksum,
      previous: batch.resumeToken ?? null,
      lastPosition,
      complete: batch.complete ?? false,
    }),
  );

/** Helpers for preparing frozen-history import batches. */
export const HistoryImport = { checksum } as const;
