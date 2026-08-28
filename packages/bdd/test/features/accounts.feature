@accounts
Feature: Customer accounts
  Registration and sign-in drive the real auth service over in-memory doubles:
  verification e-mails are captured, tokens round-trip, wrong passwords fail.

  Scenario: A customer registers and verifies their e-mail
    When "cloe@example.test" registers with password "cloemaz29" as "Cloe"
    Then the registration is accepted
    And a verification e-mail was sent to "cloe@example.test"
    And "cloe@example.test" is signed in as the current actor

  Scenario: Customers register from a profile table
    Given the following customers register:
      | email           | password | displayName   | birthdate  | referral |
      | jb@example.test | jbpass   | Jean-Baptiste | 12/08/1990 | NULL     |
      | al@example.test | alpass   | Alain         | 03/01/1985 | friends  |
    Then 2 customers have registered profiles
    And the profile of "jb@example.test" records the birthdate 1990-08-12

  Scenario: Signing in with a wrong password fails
    Given "cloe@example.test" is a registered customer
    When "cloe@example.test" signs in with password "wrong-password"
    Then an exception "InvalidCredentials" should be thrown
