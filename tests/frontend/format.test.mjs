/**
 * How a rate is printed.
 *
 * These figures matter more than they look. They are the numbers a reader
 * comes to the rate card to check, the numbers the settings dropdown quotes,
 * and the numbers the workspace estimate is costed against — so a rounding
 * that reads well is still wrong.
 *
 * They moved here from the Economics view when the settings dropdown stopped
 * carrying its own hand-typed rates and started printing these instead.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { money } from "../../web/js/format.js";

test("a rate is shown to the penny", () => {
  assert.equal(money(0.25), "$0.25");
  assert.equal(money(0.3), "$0.30");
  assert.equal(money(3.75), "$3.75");
});

test("a whole number of dollars still shows its pennies", () => {
  assert.equal(money(12), "$12.00");
  assert.equal(money(10), "$10.00");
  assert.equal(money(1.5), "$1.50", "$1.5 reads as a typo, not a price");
});

test("a rate that needs a third decimal keeps it", () => {
  // Half of $3.75 is $1.875. Rounded to the penny it becomes $1.88, which is
  // not what the batch API charges — and the discount is the whole reason
  // anyone reads this column.
  assert.equal(money(1.875), "$1.875");
  assert.equal(money(0.125), "$0.125");
  assert.equal(money(0.625), "$0.625");
  assert.equal(money(0.375), "$0.375");
});

test("a small rate is not rounded away to nothing", () => {
  assert.equal(money(0.05), "$0.05");
  assert.equal(money(0.1), "$0.10");
});

test("a rate we do not have says so, rather than reading as free", () => {
  // Number(null) and Number("") are 0. A model whose price failed to come back
  // must not be presented as one that costs nothing.
  assert.equal(money(undefined), "—");
  assert.equal(money(null), "—");
  assert.equal(money(""), "—");
  assert.equal(money("not a rate"), "—");
  assert.equal(money(0), "$0.00", "an actual zero is still a price");
});
