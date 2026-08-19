/**
 * Word-level comparison of two transcripts.
 *
 * The parts worth pinning down are the ones with a judgement in them: that
 * rewrapping is not a change, that the two comparison modes disagree in the way
 * they are supposed to, and that a page rewritten wholesale is reported as one
 * replacement rather than a shredded word-by-word trace.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  tokenise,
  normalise,
  diffTokens,
  diffPageHtml,
  comparePageSets,
  markdownToProse,
  forMode
} from "../../web/js/services/text_diff.js";

const ops = (a, b) => diffTokens(tokenise(a), tokenise(b)).map((op) => [op.op, op.tokens.join("")]);

/* ---------------------------------------------------------------- tokenising */

test("tokenising keeps the whitespace between words", () => {
  // Dropping it would make the reassembled diff unreadable.
  assert.deepEqual(tokenise("a b"), ["a", " ", "b"]);
  assert.equal(tokenise("one  two\nthree").join(""), "one  two\nthree");
});

test("tokenising nothing gives nothing", () => {
  assert.deepEqual(tokenise(""), []);
  assert.deepEqual(tokenise(null), []);
});

test("normalising collapses whitespace and trims", () => {
  assert.equal(normalise("  a   b \n c "), "a b c");
  assert.equal(normalise(null), "");
});

/* -------------------------------------------------------------------- diffing */

test("identical text produces a single equal run", () => {
  assert.deepEqual(ops("the same words", "the same words"), [["=", "the same words"]]);
});

test("an inserted word is reported as an addition, not a rewrite", () => {
  const result = ops("assets under management", "assets under active management");
  assert.deepEqual(result.filter(([op]) => op === "-"), [], "nothing was removed");
  assert.equal(result.filter(([op]) => op === "+").map(([, t]) => t).join("").trim(), "active");
});

test("a deleted word is reported as a removal", () => {
  const result = ops("net rental income rose", "net income rose");
  assert.deepEqual(result.filter(([op]) => op === "+"), []);
  assert.equal(result.filter(([op]) => op === "-").map(([, t]) => t).join("").trim(), "rental");
});

test("a changed figure shows both the old and the new", () => {
  const result = ops("profit of £12.4m", "profit of £15.9m");
  assert.equal(result.filter(([op]) => op === "-").map(([, t]) => t).join(""), "£12.4m");
  assert.equal(result.filter(([op]) => op === "+").map(([, t]) => t).join(""), "£15.9m");
});

test("the A side reassembles to the original A text", () => {
  // Anything else means the diff is showing text the document does not contain.
  const a = "one two three four";
  const b = "one two five four";
  const rebuilt = diffTokens(tokenise(a), tokenise(b))
    .filter(({ op }) => op !== "+")
    .map(({ tokens }) => tokens.join(""))
    .join("");
  assert.equal(rebuilt, a);
});

test("the B side reassembles to the original B text", () => {
  const a = "one two three four";
  const b = "one two five four";
  const rebuilt = diffTokens(tokenise(a), tokenise(b))
    .filter(({ op }) => op !== "-")
    .map(({ tokens }) => tokens.join(""))
    .join("");
  assert.equal(rebuilt, b);
});

test("two wholly different pages become one replacement, not a shredded trace", () => {
  const a = Array.from({ length: 900 }, (_, i) => `alpha${i}`).join(" ");
  const b = Array.from({ length: 900 }, (_, i) => `beta${i}`).join(" ");
  const result = diffTokens(tokenise(a), tokenise(b));
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((op) => op.op), ["-", "+"]);
});

/* ------------------------------------------------------------------ page HTML */

test("a page that only rewrapped is not a change", () => {
  // OCR rewraps freely; reporting that as a change would flag every page.
  const result = diffPageHtml("the quick brown fox", "the quick\nbrown   fox");
  assert.equal(result.changed, false);
  assert.match(result.aHtml, /diff-unchanged/);
});

test("a changed page marks up both sides and counts the words", () => {
  const result = diffPageHtml("total assets 100", "total assets 250");
  assert.equal(result.changed, true);
  assert.match(result.aHtml, /<del class="diff-del">100<\/del>/);
  assert.match(result.bHtml, /<ins class="diff-ins">250<\/ins>/);
  assert.equal(result.added, 1);
  assert.equal(result.removed, 1);
});

test("page scaffolding is stripped before comparing", () => {
  // The assembler's own headers differ whenever the page counts do; diffing
  // them would report every page as changed.
  const result = diffPageHtml("<!-- Page 3 -->\n## Page 3\nSame body.", "<!-- Page 9 -->\n## Page 9\nSame body.");
  assert.equal(result.changed, false);
});

test("markup is escaped so a transcript cannot inject HTML", () => {
  const result = diffPageHtml("<script>alert(1)</script> a", "<script>alert(1)</script> b");
  assert.ok(!result.aHtml.includes("<script>"), "raw script tag must not reach the DOM");
  assert.match(result.aHtml, /&lt;script&gt;/);
});

/* -------------------------------------------------------------- prose mode */

test("prose mode strips heading markers", () => {
  assert.equal(markdownToProse("## At a glance"), "At a glance");
});

test("prose mode reads a table row as a sentence and drops the separator", () => {
  const table = "| Assets | WAULT |\n| --- | --- |\n| £1.2bn | 11.2 yrs |";
  assert.equal(markdownToProse(table), "Assets · WAULT\n£1.2bn · 11.2 yrs");
});

test("prose mode unwraps emphasis, links, code and list markers", () => {
  assert.equal(markdownToProse("- A **bold** [link](http://x) and `code`"), "A bold link and code");
  assert.equal(markdownToProse("1. First item"), "First item");
  assert.equal(markdownToProse("> quoted line"), "quoted line");
});

test("prose mode keeps an image's alt text, which is the only prose it has", () => {
  assert.equal(markdownToProse("![Chart of income](chart.png)"), "Chart of income");
});

test("prose mode drops comments and horizontal rules", () => {
  assert.equal(markdownToProse("<!-- Page 2 -->\nBody\n\n---\n"), "Body");
});

test("a formatting-only edit is a change in source mode and not in prose mode", () => {
  // The whole reason the choice is offered: source catches a restructured
  // table, prose reads like the document. Neither is right for every job.
  const a = "| Assets | WAULT |\n| --- | --- |\n| £1.2bn | 11.2 yrs |";
  const b = "Assets · WAULT\n\n£1.2bn · 11.2 yrs";

  assert.equal(diffPageHtml(a, b, { mode: "source" }).changed, true);
  assert.equal(diffPageHtml(a, b, { mode: "prose" }).changed, false);
});

test("a real wording change is caught in both modes", () => {
  const a = "## Profit\nProfit was **£12.4m**.";
  const b = "## Profit\nProfit was **£15.9m**.";
  assert.equal(diffPageHtml(a, b, { mode: "source" }).changed, true);
  assert.equal(diffPageHtml(a, b, { mode: "prose" }).changed, true);
});

test("source is the default mode", () => {
  const a = "**bold**";
  const b = "bold";
  assert.equal(diffPageHtml(a, b).changed, diffPageHtml(a, b, { mode: "source" }).changed);
  assert.equal(diffPageHtml(a, b).changed, true);
});

test("forMode strips the page heading in both modes", () => {
  assert.equal(forMode("## Page 5\nBody.", "source"), "Body.");
  assert.equal(forMode("## Page 5\nBody.", "prose"), "Body.");
});

/* ----------------------------------------------------------- page set compare */

test("comparing page sets reports changed, shared and one-sided pages", () => {
  const a = { 1: "same", 2: "old text", 3: "only in A" };
  const b = { 1: "same", 2: "new text", 4: "only in B" };
  const result = comparePageSets(a, b);

  assert.deepEqual(result.sharedPages, [1, 2]);
  assert.deepEqual(result.changedPages, [2]);
  assert.deepEqual(result.onlyInA, [3]);
  assert.deepEqual(result.onlyInB, [4]);
});

test("the page set ignores the preamble entry", () => {
  const result = comparePageSets({ preamble: "header", 1: "x" }, { preamble: "other", 1: "x" });
  assert.deepEqual(result.sharedPages, [1]);
  assert.deepEqual(result.changedPages, []);
});

test("which pages changed follows the chosen mode", () => {
  const a = { 1: "| Assets |\n| --- |\n| £1.2bn |" };
  const b = { 1: "Assets\n\n£1.2bn" };

  assert.deepEqual(comparePageSets(a, b, { mode: "source" }).changedPages, [1]);
  assert.deepEqual(comparePageSets(a, b, { mode: "prose" }).changedPages, []);
});
