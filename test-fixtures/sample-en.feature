Feature: Calculator

  Scenario: Add two numbers
    Given I have entered 50 into the calculator
    And I have entered 70 into the calculator
    When I press add
    Then the result should be 120 on the screen

  Scenario: Subtract two numbers
    Given I have entered 100 into the calculator
    And I have entered 30 into the calculator
    When I press subtract
    Then the result should be 70 on the screen

  Scenario Outline: Multiple operations
    Given I have entered <input_1> into the calculator
    And I have entered <input_2> into the calculator
    When I press <operator>
    Then the result should be <result> on the screen

    Examples:
      | input_1 | input_2 | operator | result |
      | 10      | 5       | add      | 15     |
      | 20      | 3       | subtract | 17     |
      | 4       | 5       | multiply | 20     |

  @wip
  Scenario: Division by zero
    Given I have entered 10 into the calculator
    And I have entered 0 into the calculator
    When I press divide
    Then I should see an error message

  # This is a comment
  Rule: Basic arithmetic

    Background:
      Given the calculator is turned on

    Scenario: Clear display
      When I press clear
      Then the display should show 0

    # Another comment with 中文
    Scenario: Memory functions
      Given I have entered 42 into the calculator
      When I press memory store
      And I press clear
      And I press memory recall
      Then the result should be 42 on the screen
