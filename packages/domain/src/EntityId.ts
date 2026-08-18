import { type Brand, Schema } from "effect";

/** A string branded with the entity's name. */
export type Branded<Name extends string> = string & Brand.Brand<Name>;

/**
 * Branded string identifier for one entity type, so a `UserId` can never be
 * passed where an `OrderId` is expected.
 */
export interface EntityId<Name extends string> {
  readonly name: Name;
  readonly schema: Schema.Schema<Branded<Name>, string>;
  /** Validates and brands an existing raw id. */
  readonly make: (raw: string) => Branded<Name>;
  /** Generates a new random (UUID) id. */
  readonly generate: () => Branded<Name>;
}

export const define = <Name extends string>(name: Name): EntityId<Name> => {
  const schema = Schema.String.pipe(Schema.minLength(1), Schema.brand(name)) as Schema.Schema<
    Branded<Name>,
    string
  >;
  const make = Schema.decodeSync(schema);
  return {
    name,
    schema,
    make,
    generate: () => make(crypto.randomUUID()),
  };
};

/** The type of ids produced by an `EntityId` definition. */
export type Of<T> = T extends EntityId<infer Name> ? Branded<Name> : never;
