Feature: Calculator (TypeScript)

  Scenario: Add two numbers
    Given I have entered 50 into the calculator
    And I have entered 70 into the calculator
    When I press add
    Then the result should be 120 on the screen

  Scenario Outline: Many operations
    Given I have entered <a> into the calculator
    And I have entered <b> into the calculator
    When I press <op>
    Then the result should be <out> on the screen

    Examples:
      | a  | b | op       | out |
      | 10 | 5 | add      | 15  |
      | 20 | 3 | subtract | 17  |
