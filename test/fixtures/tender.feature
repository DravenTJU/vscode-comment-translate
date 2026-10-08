# language: en
@smoke @tender
Feature: Tender submission
  As a supplier I want to submit a tender
  so that the buyer can review it.

  Background:
    Given I am logged in as "supplier@bidone.co.nz"

  Scenario Outline: Submit a tender with an attachment
    When I open the tender "<tenderName>"
    And I click "Submit"
    Then I should see "Submission successful"

    Examples:
      | tenderName     |
      | Milk Supply Q3 |

  # A scenario with a payload
  Scenario: Reject an invalid payload
    When I post the payload
      """
      {
        "amount": 100,

        "currency": "NZD"
      }
      """
    Then the response status should be 400
