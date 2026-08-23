Feature: order lifecycle
  English feature exercising exact / parse / regex matchers.

  Scenario: exact step matching
    Given an approved merchant
    When the merchant submits a refund
    Then the refund appears in the queue

  Scenario: typed parameters
    Given user 42 has 3 pending orders
    When the user cancels order 1001
    Then the pending count is 2
