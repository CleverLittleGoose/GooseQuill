/**
 * The rate card's two judgements: how much a rate is, and what to call the
 * model charging it.
 *
 * The figures matter more than they look. These are the numbers a reader comes
 * to this view to check, and they are the same numbers the workspace estimate
 * is costed against — so a rounding that reads well is still wrong.
 */

import test from "node:test";
import assert from "node:assert/strict";

const noop = () => {};
globalThis.document = { addEventListener: noop, getElementById: () => null, createElement: () => ({ style: {} }) };
globalThis.window = { addEventListener: noop };

const { money, badgeFor } = await import("../../web/js/components/economics_view.js");

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

test("the default model is badged as the default, whatever its tier says", () => {
  const badge = badgeFor("gemini-3.1-flash-lite", "Default / Economy", "gemini-3.1-flash-lite");
  assert.deepEqual(badge, { text: "Default", className: "default" });
});

test("a tier earns its badge", () => {
  assert.equal(badgeFor("m", "Pro", "other").text, "Pro");
  assert.equal(badgeFor("m", "Frontier Pro", "other").text, "Pro", "Pro wins where a tier claims both");
  assert.equal(badgeFor("m", "Frontier Flash", "other").text, "Frontier");
  assert.equal(badgeFor("m", "Economy", "other").text, "Economy");
  assert.equal(badgeFor("m", "Preview Flash", "other").text, "Preview");
});

test("an unremarkable tier gets no badge rather than an empty one", () => {
  assert.equal(badgeFor("m", "Standard Flash", "other"), null);
  assert.equal(badgeFor("m", "", "other"), null);
});
