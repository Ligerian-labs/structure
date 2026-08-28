@reservations
Feature: Reservations
  As a customer
  I want to request a stay at the villa
  So that the owner can confirm my booking with a priced quotation

  Background:
    Given a nightly rate of 300 € for villa "savanne"
    And registered customers:
      | email                 |
      | valentin@example.test |
      | cloe@example.test     |

  @happy
  Scenario: A valid booking request is accepted
    Given "valentin@example.test" is logged in
    And a booking request from "2026-07-01" to "2026-07-15"
    When the customer submits the booking request
    Then it is accepted with a total of "4 200,00 €"
    And 1 email should have been sent
    And a "ReservationRequested" event should have been dispatched
    And the villa should show 1 reservation

  Scenario: Invalid dates are rejected
    Given "valentin@example.test" is logged in
    And a booking request from "2026-07-15" to "2026-07-01"
    When the customer submits the booking request
    Then an exception "InvalidPeriod" should be thrown with message "End date 2026-07-01 cannot be before start date 2026-07-15"
    And 0 emails should have been sent

  Scenario: Overlapping booking is rejected
    Given "cloe@example.test" is logged in
    And the villa is already booked:
      | customer              | from       | to         | guests |
      | cloe@example.test     | 2026-07-01 | 2026-07-10 | 2      |
    And "valentin@example.test" is logged in
    And a booking request from "2026-07-05" to "2026-07-12"
    When the customer submits the booking request
    Then an exception "AlreadyBooked" should be thrown

  Scenario: The customer acknowledged the cancellation policy
    Given "valentin@example.test" is logged in
    And the customer read the cancellation policy:
      """
      Caution: 2 000 € — household: 200 €.
      Full refund until 30 days before arrival.
      """
    When a booking request is made with the policy acknowledged
    Then the acknowledgement is recorded
    And it is accepted with a total of "4 200,00 €"

  @wip
  Scenario: The owner validates the reservation
    Given an owner is logged in
