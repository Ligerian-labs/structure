import type { StoredEventMetadata } from "@structure-ai/eventsourcing";
import { NisshiProtocolError } from "./protocol/errors.js";

/**
 * The JSON envelope persisted as the record value; the stream name is the
 * record key. `version` travels inside the envelope because offsets are
 * global per topic while versions number one stream's events.
 */
export interface WireEvent {
  readonly type: string;
  readonly schemaVersion: number;
  readonly version: number;
  readonly payload: unknown;
  readonly metadata: StoredEventMetadata;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Serializes the envelope; `undefined` payload collapses to `null`. */
export const encodeWireEvent = (event: WireEvent): Uint8Array =>
  encoder.encode(JSON.stringify({ ...event, payload: event.payload ?? null }));

/** Parses a record value into an envelope, failing on malformed JSON. */
export const decodeWireEvent = (value: Uint8Array, streamName: string): WireEvent => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(value));
  } catch (cause) {
    throw new NisshiProtocolError({
      reason: `malformed event envelope for ${streamName}: ${String(cause)}`,
    });
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new NisshiProtocolError({ reason: `event envelope for ${streamName} is not an object` });
  }
  const record = parsed as Record<string, unknown>;
  const { type, schemaVersion, version, payload, metadata } = record;
  if (
    typeof type !== "string" ||
    typeof schemaVersion !== "number" ||
    typeof version !== "number"
  ) {
    throw new NisshiProtocolError({
      reason: `event envelope for ${streamName} misses typed fields`,
    });
  }
  if (typeof metadata !== "object" || metadata === null) {
    throw new NisshiProtocolError({
      reason: `event envelope for ${streamName} has no metadata object`,
    });
  }
  return {
    type,
    schemaVersion,
    version,
    payload: payload ?? null,
    metadata: metadata as StoredEventMetadata,
  };
};

/**
 * Minimal client-side envelope validation (defense in depth before produce).
 * Broker-side validation is stronger and optional — see `writeSchemaFiles`.
 */
export const validateWireEvent = (event: WireEvent, streamName: string): void => {
  if (event.type.length === 0) {
    throw new NisshiProtocolError({ reason: `event for ${streamName} has an empty type` });
  }
  if (!Number.isSafeInteger(event.schemaVersion) || event.schemaVersion < 1) {
    throw new NisshiProtocolError({
      reason: `event ${event.type} for ${streamName} has schemaVersion ${event.schemaVersion}`,
    });
  }
  if (!Number.isSafeInteger(event.version) || event.version < 1) {
    throw new NisshiProtocolError({
      reason: `event ${event.type} for ${streamName} has version ${event.version}`,
    });
  }
  const occurredAt = (event.metadata as Record<string, unknown>).occurredAt;
  if (typeof occurredAt !== "string" || occurredAt.length === 0) {
    throw new NisshiProtocolError({
      reason: `event ${event.type} for ${streamName} misses metadata.occurredAt`,
    });
  }
};
