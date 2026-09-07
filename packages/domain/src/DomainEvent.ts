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
 *
 * Three optional fields let an application place an event in a subset of
 * the store without the framework learning what the subset means:
 *
 * - `partition` is a locality key (an agency, a tenant, a shard). The one
 *   rule the framework enforces is that a stream's partition never changes:
 *   every event of one stream carries the same value, or none. What a
 *   partition means and who may write to it are application policy.
 * - `origin` is set only on a replicated copy: the node that first recorded
 *   the event and its global position there, a bigint carried as a decimal
 *   string. The aggregate runtime never sets it.
 * - `extensions` is an application-owned JSON bag the framework does not
 *   interpret. Decode it with your own schema at the consuming edge.
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
  partition: Schema.optional(Schema.String),
  origin: Schema.optional(Schema.Struct({ node: Schema.String, position: Schema.String })),
  extensions: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
}) {}

/** An event together with its envelope metadata. */
export interface Envelope<E> {
  readonly metadata: EventMetadata;
  readonly event: E;
}
