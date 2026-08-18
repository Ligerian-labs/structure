import { Data, Effect, Schema } from "effect";
import { TreeFormatter } from "effect/ParseResult";
import * as AST from "effect/SchemaAST";

/**
 * Wire form of an event: a stable type name, the schema version the payload
 * was written with, and a JSON-encodable payload. This is what adapters
 * persist and what the registry decodes back into domain events.
 */
export interface SerializedEvent {
  readonly type: string;
  readonly schemaVersion: number;
  readonly payload: unknown;
}

/**
 * A stored event could not be decoded into a domain event: unknown type,
 * missing upcaster, or a payload that fails schema validation.
 * Permanent — retrying cannot repair a bad payload; route it to a dead
 * letter or fix the registry/upcasters and rebuild.
 */
export class EventDecodeError extends Data.TaggedError("EventDecodeError")<{
  readonly type: string;
  readonly schemaVersion: number;
  readonly reason: string;
}> {
  /** Failure classification per the production contract. */
  readonly classification = "permanent" as const;
  override get message(): string {
    return `cannot decode event "${this.type}" (schema v${this.schemaVersion}): ${this.reason}`;
  }
}

/**
 * One registered event type.
 *
 * - `schema` must be a `Schema.TaggedStruct`-style schema: its `Type` carries
 *   a literal string `_tag` which doubles as the persisted `type` name.
 * - `schemaVersion` is the version the schema currently writes.
 * - `upcasters` maps a stored `fromVersion` to a function producing the
 *   payload shape of `fromVersion + 1`; they are applied in sequence until
 *   the payload reaches `schemaVersion`, then the schema decodes it.
 */
export interface EventRegistryEntry<
  S extends Schema.Schema.AnyNoContext = Schema.Schema.AnyNoContext,
> {
  readonly schema: S;
  readonly schemaVersion: number;
  readonly upcasters?: Readonly<Record<number, (payload: unknown) => unknown>>;
}

/**
 * Encodes domain events for storage and decodes stored events back,
 * upcasting old payloads to the current schema version first.
 */
export interface EventRegistry<E extends { readonly _tag: string }> {
  /**
   * Serializes an event of a registered type. Throws (a defect when run
   * inside an Effect) if the event's tag is not registered or the payload
   * fails to encode — both are programmer errors, not runtime conditions.
   */
  readonly encode: (event: E) => SerializedEvent;
  /**
   * Decodes a stored event: applies upcasters from the stored version up to
   * the registered `schemaVersion`, then validates with the schema. Fails
   * with `EventDecodeError` (permanent) on unknown type, missing upcaster,
   * a stored version newer than the registered one, or invalid payload.
   */
  readonly decode: (stored: SerializedEvent) => Effect.Effect<E, EventDecodeError>;
  /** Whether a stored `type` name is known to this registry. */
  readonly has: (type: string) => boolean;
}

/** Extracts the literal string `_tag` from a TaggedStruct-style schema AST. */
const tagOf = (schema: Schema.Schema.AnyNoContext): string => {
  const ast = schema.ast;
  if (AST.isTypeLiteral(ast)) {
    for (const property of ast.propertySignatures) {
      if (
        property.name === "_tag" &&
        AST.isLiteral(property.type) &&
        typeof property.type.literal === "string"
      ) {
        return property.type.literal;
      }
    }
  }
  throw new Error("event schema must be a TaggedStruct with a literal string _tag");
};

interface CompiledEntry {
  readonly entry: EventRegistryEntry;
  readonly encodePayload: (event: unknown) => unknown;
  readonly decodePayload: (payload: unknown) => Effect.Effect<unknown, EventDecodeError>;
}

/**
 * Builds an `EventRegistry` from entries. The event union is inferred from
 * the entry schemas; each schema's `_tag` literal is the persisted type name
 * and must be unique within the registry.
 */
const make = <const Entries extends ReadonlyArray<EventRegistryEntry>>(
  entries: Entries,
): EventRegistry<
  Extract<Schema.Schema.Type<Entries[number]["schema"]>, { readonly _tag: string }>
> => {
  type E = Extract<Schema.Schema.Type<Entries[number]["schema"]>, { readonly _tag: string }>;

  const byTag = new Map<string, CompiledEntry>();
  for (const entry of entries) {
    const tag = tagOf(entry.schema);
    if (byTag.has(tag)) {
      throw new Error(`duplicate event type "${tag}" in registry`);
    }
    const encodeSync = Schema.encodeUnknownSync(entry.schema);
    const decodeUnknown = Schema.decodeUnknown(entry.schema);
    byTag.set(tag, {
      entry,
      encodePayload: (event) => encodeSync(event) as unknown,
      decodePayload: (payload) =>
        decodeUnknown(payload).pipe(
          Effect.mapError(
            (error) =>
              new EventDecodeError({
                type: tag,
                schemaVersion: entry.schemaVersion,
                reason: TreeFormatter.formatErrorSync(error),
              }),
          ),
        ) as Effect.Effect<unknown, EventDecodeError>,
    });
  }

  const encode = (event: E): SerializedEvent => {
    const compiled = byTag.get(event._tag);
    if (compiled === undefined) {
      throw new Error(`event type "${event._tag}" is not registered`);
    }
    return {
      type: event._tag,
      schemaVersion: compiled.entry.schemaVersion,
      payload: compiled.encodePayload(event),
    };
  };

  const decode = (stored: SerializedEvent): Effect.Effect<E, EventDecodeError> =>
    Effect.suspend(() => {
      const compiled = byTag.get(stored.type);
      if (compiled === undefined) {
        return Effect.fail(
          new EventDecodeError({
            type: stored.type,
            schemaVersion: stored.schemaVersion,
            reason: "unknown event type",
          }),
        );
      }
      const current = compiled.entry.schemaVersion;
      if (stored.schemaVersion > current) {
        return Effect.fail(
          new EventDecodeError({
            type: stored.type,
            schemaVersion: stored.schemaVersion,
            reason: `stored schema version is newer than the registered version ${current}`,
          }),
        );
      }
      let payload = stored.payload;
      for (let version = stored.schemaVersion; version < current; version++) {
        const upcast = compiled.entry.upcasters?.[version];
        if (upcast === undefined) {
          return Effect.fail(
            new EventDecodeError({
              type: stored.type,
              schemaVersion: stored.schemaVersion,
              reason: `no upcaster from schema version ${version}`,
            }),
          );
        }
        try {
          payload = upcast(payload);
        } catch (error) {
          return Effect.fail(
            new EventDecodeError({
              type: stored.type,
              schemaVersion: stored.schemaVersion,
              reason: `upcaster from version ${version} threw: ${String(error)}`,
            }),
          );
        }
      }
      return compiled.decodePayload(payload) as Effect.Effect<E, EventDecodeError>;
    });

  return { encode, decode, has: (type) => byTag.has(type) };
};

/**
 * Event (de)serialization with versioned schemas and upcasters.
 * See `EventRegistry.make`.
 */
export const EventRegistry = { make } as const;
