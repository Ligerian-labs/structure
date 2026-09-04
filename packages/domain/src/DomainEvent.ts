import { Schema } from "effect";

/**
 * A domain event is an immutable, past-tense business fact. Define one with
 * a tag and a payload schema; the resulting schema is used for persistence,
 * projections, and translation into integration events at the boundary.
 */
export const define = <Tag extends string, Fields extends Schema.Struct.Fields>(
  tag: Tag,
  fields: Fields,
) => Schema.TaggedStruct(tag, fields);

/**
 * Metadata carried alongside every persisted or published event. Identity
 * and ordering come from the aggregate; correlation ties the event to the
 * workflow that produced it. `actor` records the authenticated principal
 * when the caller supplies one; consumers must not treat it as authorization proof.
 */
export class EventMetadata extends Schema.Class<EventMetadata>("EventMetadata")({
  eventId: Schema.String,
  occurredAt: Schema.DateTimeUtc,
  aggregateName: Schema.String,
  aggregateId: Schema.String,
  aggregateVersion: Schema.Number,
  correlationId: Schema.optional(Schema.String),
  causationId: Schema.optional(Schema.String),
  actor: Schema.optional(Schema.String),
}) {}

/** An event together with its envelope metadata. */
export interface Envelope<E> {
  readonly metadata: EventMetadata;
  readonly event: E;
}
