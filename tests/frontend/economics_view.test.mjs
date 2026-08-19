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

const { money, badgeFor, syncStampText } = await import("../../web/js/components/economics_view.js");

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

/*
 * When the rates were last checked.
 *
 * The distinction these tests protect is the one the line exists for: a card
 * that has never been synced shows the same figures, in the same table, as one
 * synced this morning. If "never" ever starts reading like "recently", the
 * reader has no way left to tell a current rate from a frozen one.
 */

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-08-19T12:00:00Z");

test("rates that have never been synced say so, and say what they are instead", () => {
  const stamp = syncStampText(null, NOW);
  assert.match(stamp.text, /never synced/i);
  assert.match(stamp.text, /bundled with this release/i,
    "the reader needs to know what they are looking at, not just what it is not");
  assert.equal(stamp.stale, true, "unchecked figures are exactly the ones to flag");
});

test("a missing timestamp is treated as never synced, however it arrives", () => {
  for (const nothing of [null, undefined, ""]) {
    assert.match(syncStampText(nothing, NOW).text, /never synced/i);
  }
});

test("a recent sync is reported in the units a reader thinks in", () => {
  assert.equal(syncStampText(new Date(NOW - 20 * 1000).toISOString(), NOW).text, "Rates synced just now");
  assert.equal(syncStampText(new Date(NOW - 5 * 60 * 1000).toISOString(), NOW).text, "Rates synced 5 minutes ago");
  assert.equal(syncStampText(new Date(NOW - 3 * HOUR).toISOString(), NOW).text, "Rates synced 3 hours ago");
  assert.equal(syncStampText(new Date(NOW - 4 * DAY).toISOString(), NOW).text, "Rates synced 4 days ago");
});

test("one of something is not '1 minutes ago'", () => {
  assert.equal(syncStampText(new Date(NOW - 60 * 1000).toISOString(), NOW).text, "Rates synced 1 minute ago");
  assert.equal(syncStampText(new Date(NOW - HOUR).toISOString(), NOW).text, "Rates synced 1 hour ago");
  assert.equal(syncStampText(new Date(NOW - DAY).toISOString(), NOW).text, "Rates synced 1 day ago");
});

test("a sync goes stale after a month, and not before", () => {
  assert.equal(syncStampText(new Date(NOW - 29 * DAY).toISOString(), NOW).stale, false);
  assert.equal(syncStampText(new Date(NOW - 30 * DAY).toISOString(), NOW).stale, true);
});

test("a clock behind the server does not report rates synced in the future", () => {
  // The stamp is drawn from the server's clock against the browser's, so a
  // machine a few seconds slow would otherwise produce a negative age.
  const stamp = syncStampText(new Date(NOW + 30 * 1000).toISOString(), NOW);
  assert.equal(stamp.text, "Rates synced just now");
});

test("a timestamp that cannot be read says so rather than showing Invalid Date", () => {
  const stamp = syncStampText("not-a-date", NOW);
  assert.match(stamp.text, /unknown time/i);
  assert.doesNotMatch(stamp.text, /invalid date/i);
  assert.equal(stamp.stale, true, "a date we cannot read is not a date we can trust");
});

test("the exact moment is available without cluttering the line", () => {
  const stamp = syncStampText("2026-08-19T09:00:00Z", NOW);
  assert.equal(stamp.text, "Rates synced 3 hours ago");
  assert.ok(stamp.title && stamp.title.length > 0, "the precise time belongs in the tooltip");
});
