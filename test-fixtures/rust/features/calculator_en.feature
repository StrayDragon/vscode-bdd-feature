Feature: calculator
  rstest-bdd fixture — English scenario with typed placeholders.

  Scenario: typed addition
    Given a cleared calculator
    When I enter 3
    And I enter 4
    Then the display shows 7

  Scenario: quoted string argument
    Given configured mock model "fake-model"
    When operation "ensure-session" runs
    Then the operation succeeds
