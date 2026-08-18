import { Either, Schema } from "effect";
import { ArrayFormatter } from "effect/ParseResult";
import { ValidationFailed } from "./errors.js";

/**
 * A value object is a self-validating, immutable, structurally-compared
 * value. Effect Schema already provides structure and validation; this
 * helper adds a named constructor that fails with the domain's
 * `ValidationFailed` error instead of a raw parse error.
 */
export interface ValueObject<A, I> {
  readonly name: string;
  readonly schema: Schema.Schema<A, I>;
  /** Decodes unknown input, failing with `ValidationFailed`. */
  readonly from: (input: unknown) => Either.Either<A, ValidationFailed>;
  /** Decodes trusted input, throwing on failure — for literals in code. */
  readonly make: (input: I) => A;
  readonly is: (value: unknown) => value is A;
}

export const define = <A, I = A>(name: string, schema: Schema.Schema<A, I>): ValueObject<A, I> => {
  const decode = Schema.decodeUnknownEither(schema, { errors: "all" });
  return {
    name,
    schema,
    from: (input) =>
      Either.mapLeft(
        decode(input),
        (error) =>
          new ValidationFailed({
            subject: name,
            issues: ArrayFormatter.formatErrorSync(error).map(
              (issue) => `${issue.path.join(".")}: ${issue.message}`,
            ),
          }),
      ),
    make: (input) => Schema.decodeSync(schema)(input as never),
    is: Schema.is(schema),
  };
};
