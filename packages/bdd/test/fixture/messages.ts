import { Command, Query } from "@structure-ai/cqrs";
import { Schema } from "effect";

/** Business failures of the reservation flow. */
export class InvalidPeriod extends Schema.TaggedError<InvalidPeriod>()("InvalidPeriod", {
  message: Schema.String,
}) {}

export class AlreadyBooked extends Schema.TaggedError<AlreadyBooked>()("AlreadyBooked", {
  from: Schema.String,
  to: Schema.String,
}) {}

export const reservationFailures = Schema.Union(InvalidPeriod, AlreadyBooked);
export type ReservationFailure = InvalidPeriod | AlreadyBooked;

export const RequestReservation = Command.define("RequestReservation", {
  payload: Schema.Struct({
    resourceId: Schema.String,
    from: Schema.String,
    to: Schema.String,
  }),
  success: Schema.Struct({
    reservationId: Schema.String,
    totalAmount: Schema.String,
  }),
  failure: reservationFailures,
});

export const ListReservations = Query.define("ListReservations", {
  payload: Schema.Struct({}),
  success: Schema.Struct({
    reservations: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        from: Schema.String,
        to: Schema.String,
        totalAmount: Schema.String,
      }),
    ),
  }),
});

/** The single integration-relevant fact of this fixture domain. */
export const ReservationRequested = Schema.Struct({
  _tag: Schema.Literal("ReservationRequested"),
  reservationId: Schema.String,
  resourceId: Schema.String,
  from: Schema.String,
  to: Schema.String,
  totalAmount: Schema.String,
});

export type ReservationRequested = Schema.Schema.Type<typeof ReservationRequested>;
