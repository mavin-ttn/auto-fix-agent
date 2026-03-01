/**
 * index.js
 *
 * Sample file with a deliberate bug to test the agent.
 *
 * Bug: calculateDiscount() multiplies by (1 + rate) instead of (1 - rate),
 * so applying a 20% discount coupon INCREASES the price by 20%.
 *
 * Corresponding Jira ticket: BUG-42
 * Summary: "Discount coupon raises cart total instead of lowering it"
 */

function calculateDiscount(price, discountPercent) {
    const discountRate = discountPercent / 100;
    return price * (1 + discountRate); // ← BUG: should be (1 - discountRate)
  }
  
module.exports = { calculateDiscount };