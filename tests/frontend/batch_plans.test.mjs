/**
 * The batch plan view's judgements.
 *
 * A plan file is shared: the CLI and the browser drive the same one. Most of
 * what this view decides is about that — whether a step is ours to take, and
 * whether what we are looking at is moving. Those decisions are the ones worth
 * pinning down, because getting them wrong means either a button that silently
 * loses a race, or a screen that looks stalled while a terminal works.
 */

import test from "node:test";
import assert from "node:assert/strict";

const noop = () => {};
globalThis.document = {
  addEventListener: noop,
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ style: {}, classList: { add: noop }, appendChild: noop })
};
globalThis.window = { addEventListener: noop };
globalThis.localStorage = { getItem: () => null, setItem: noop };

const {
  cost,
  planLabel,
  stepAvailability,
  planBadge,
  groupBadge,
  missingPages,
  failedGroupCount,
  retryAvailability,
  pollIntervalFor
} = await import("../../web/js/components/batch_plans.js");

/* -------------------------------------------------------------------- */

test("a plan id reads as the time it was made", () => {
  assert.equal(planLabel("plan_20260822_124430"), "22 Aug 2026, 12:44");
  assert.equal(planLabel("plan_20260101_090000"), "1 Jan 2026, 09:00");
});

test("an id that is not a timestamp is shown as it is, not mangled", () => {
  assert.equal(planLabel("plan_whatever"), "plan_whatever");
  assert.equal(planLabel("plan_20261322_124430"), "plan_20261322_124430", "month 13");
  assert.equal(planLabel(""), "Plan");
  assert.equal(planLabel(null), "Plan");
});

/*
 * Stepping.
 *
 * The distinction that matters: a plan being advanced by a terminal is not
 * finished, not idle, and not ours. Offering the button would start a step
 * that waits thirty seconds for a lock and gives up somewhere nobody looks.
 */

test("a plan with work left and nobody on it can be stepped", () => {
  const { enabled, reason } = stepAvailability({ is_finished: false });
  assert.equal(enabled, true);
  assert.equal(reason, "");
});

test("a plan held by another process cannot be stepped, and says who has it", () => {
  const { enabled, reason } = stepAvailability({ locked: true, is_finished: false });
  assert.equal(enabled, false);
  assert.match(reason, /terminal/);
});

test("a lock outranks every other reason, so the message names the real cause", () => {
  // A finished plan that is still locked is being retried by someone. Saying
  // "every group has finished" would invite a click that cannot work.
  const { enabled, reason } = stepAvailability({ locked: true, is_finished: true });
  assert.equal(enabled, false);
  assert.match(reason, /terminal/);
});

test("a plan already stepping here is not offered a second step", () => {
  assert.equal(stepAvailability({ advancing: true }).enabled, false);
});

test("a finished plan is not offered a step", () => {
  const { enabled, reason } = stepAvailability({ is_finished: true });
  assert.equal(enabled, false);
  assert.match(reason, /finished/);
});

test("nothing to judge is not something to click", () => {
  assert.equal(stepAvailability(null).enabled, false);
  assert.equal(stepAvailability(undefined).enabled, false);
});

/*
 * Badges.
 */

test("a plan that finished cleanly is finished", () => {
  assert.deepEqual(
    planBadge({ is_finished: true, counts: { collected: 38 } }),
    { text: "Finished", className: "done" }
  );
});

test("a plan that ended with failures does not get to say Finished", () => {
  // It is finished in the state machine's sense and not at all in the reader's.
  const badge = planBadge({ is_finished: true, counts: { collected: 36, failed: 2 } });
  assert.equal(badge.className, "failed");
  assert.match(badge.text, /2 failed/);
});

test("work in flight is told apart from work someone else is driving", () => {
  assert.equal(planBadge({ counts: { submitted: 3 } }).text, "Waiting on Google");
  assert.equal(planBadge({ locked: true, counts: { submitted: 3 } }).text, "Running in a terminal");
  assert.equal(planBadge({ advancing: true }).text, "Stepping");
});

test("a plan that has never been started says so", () => {
  assert.deepEqual(
    planBadge({ counts: { pending: 38 }, is_finished: false }),
    { text: "Not started", className: "idle" }
  );
});

test("every group state earns a badge, and an unknown one is not a blank", () => {
  assert.equal(groupBadge({ state: "collected" }).className, "done");
  assert.equal(groupBadge({ state: "complete" }).text, "Already done");
  assert.equal(groupBadge({ state: "submitted" }).className, "running");
  assert.equal(groupBadge({ state: "failed" }).className, "failed");
  assert.equal(groupBadge({ state: "pending" }).text, "Waiting");
  assert.equal(groupBadge({ state: "something-new" }).text, "Waiting");
});

/*
 * Pages still missing.
 *
 * Counted from what the cache holds, which is the only thing that answers "did
 * it do these pages". A group's `blocked` list is a log of what one collection
 * was refused, and most of those pages come back on the retry that follows —
 * reading it as the current state had a plan offering to retry 191 pages when
 * 8 were missing.
 */

test("missing pages are counted across the whole plan", () => {
  const plan = {
    groups: [
      { pages: 100, converted: 98, missing: 2, retry_pass: 1 },
      { pages: 50, converted: 50, missing: 0 },
      { pages: 20, converted: 19, missing: 1 },
      { pages: 10, converted: 10 }
    ]
  };
  assert.deepEqual(missingPages(plan, 3), { retryable: 3, exhausted: 0 });
});

test("a refusal log is not read as the current state", () => {
  // Every page here was refused once and obtained on the retry. Nothing is
  // missing, so nothing should be offered.
  const plan = {
    groups: [{ pages: 40, converted: 40, missing: 0, blocked: [{}, {}, {}], retry_pass: 1 }]
  };
  assert.deepEqual(missingPages(plan, 3), { retryable: 0, exhausted: 0 });
});

test("pages that have used every prompt are counted apart from the rest", () => {
  // Reopening skips a group that has exhausted its prompts, so counting these
  // on the retry button would promise pages the retry cannot deliver.
  const plan = {
    groups: [
      { missing: 2, retry_pass: 1 },
      { missing: 3, retry_pass: 3 },
      { missing: 1, retry_pass: 4 }
    ]
  };
  assert.deepEqual(missingPages(plan, 3), { retryable: 2, exhausted: 4 });
});

test("how many passes there are comes from the server, not a guess here", () => {
  const plan = { groups: [{ missing: 1, retry_pass: 3 }] };
  assert.deepEqual(missingPages(plan, 5), { retryable: 1, exhausted: 0 });
  assert.deepEqual(missingPages(plan, 3), { retryable: 0, exhausted: 1 });
  // Missing or nonsense falls back to the three prompts that exist today.
  assert.deepEqual(missingPages(plan, undefined), { retryable: 0, exhausted: 1 });
});

test("a plan with nothing missing counts none", () => {
  assert.deepEqual(missingPages({ groups: [{}, { missing: 0 }] }, 3), { retryable: 0, exhausted: 0 });
  assert.deepEqual(missingPages(null, 3), { retryable: 0, exhausted: 0 });
  assert.deepEqual(missingPages({}, 3), { retryable: 0, exhausted: 0 });
});

/*
 * Retrying is not stepping.
 *
 * This is the distinction the first version of this view got wrong: it gated
 * the retry button on the same condition as the step button, so a finished
 * plan with refused pages — the one case the retry exists for — offered a
 * button that could never be clicked.
 */

test("a finished plan can still retry the pages it was refused", () => {
  assert.equal(stepAvailability({ is_finished: true }).enabled, false);
  assert.equal(retryAvailability({ is_finished: true }).enabled, true);
});

test("a retry still waits for whoever else is driving the plan", () => {
  assert.equal(retryAvailability({ is_finished: true, locked: true }).enabled, false);
  assert.equal(retryAvailability({ advancing: true }).enabled, false);
  assert.equal(retryAvailability(null).enabled, false);
});

/*
 * What a plan costs.
 *
 * The shared `money()` formatter prints a third decimal when a rate needs one,
 * which is right for $1.875 per million tokens and wrong for a plan total —
 * $12.414 is three decimals of false precision on an estimate.
 */

test("a plan total is priced to the penny, not to the tenth of one", () => {
  assert.equal(cost(12.4139), "$12.41");
  assert.equal(cost(1.7982), "$1.80");
  assert.equal(cost(0), "$0.00");
});

test("a cost that is not a number is not printed as free", () => {
  assert.equal(cost(null), "—");
  assert.equal(cost(undefined), "—");
  assert.equal(cost("nonsense"), "—");
});

/*
 * Failed groups.
 *
 * A failure used to be permanent by construction — the submit loop only ever
 * looks at pending groups, so nothing could put one back. The count is what
 * puts the button on the card that can.
 */

test("failed groups are counted from the plan's own tally", () => {
  assert.equal(failedGroupCount({ counts: { collected: 36, failed: 2 } }), 2);
  assert.equal(failedGroupCount({ counts: { collected: 38 } }), 0);
  assert.equal(failedGroupCount({}), 0);
  assert.equal(failedGroupCount(null), 0);
});

test("a finished plan with failures can still reopen them", () => {
  const summary = { is_finished: true, counts: { failed: 2 } };
  assert.equal(stepAvailability(summary).enabled, false, "nothing pending to step");
  assert.equal(retryAvailability(summary).enabled, true, "but reopening is the point");
});

/*
 * Polling.
 */

test("anything unfinished is watched closely", () => {
  const fast = pollIntervalFor([{ is_finished: true }, { is_finished: false }]);
  const slow = pollIntervalFor([{ is_finished: true }, { is_finished: true }]);
  assert.ok(fast < slow, `expected ${fast} to be shorter than ${slow}`);
});

test("a finished plan someone else has reopened is still watched closely", () => {
  const locked = pollIntervalFor([{ is_finished: true, locked: true }]);
  const quiet = pollIntervalFor([{ is_finished: true }]);
  assert.ok(locked < quiet);
});

test("an empty screen still checks back, because a terminal can start one", () => {
  assert.ok(pollIntervalFor([]) > 0);
  assert.ok(pollIntervalFor(null) > 0);
});
