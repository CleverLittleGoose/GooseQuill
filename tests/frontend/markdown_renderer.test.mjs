/**
 * Display-layer normalisation of OCR output.
 *
 * The transcript is whatever the model returned, and some of what it returns is
 * scenery rather than content. These are the shapes worth flattening before
 * Markdown gets hold of them.
 */

import test from "node:test";
import assert from "node:assert/strict";

// The module builds a renderer at import time and that touches the DOM.
const noop = () => {};
globalThis.document = {
  addEventListener: noop,
  createElement: () => ({ style: {}, classList: { add: noop }, addEventListener: noop }),
  querySelectorAll: () => [],
  body: { appendChild: noop }
};
globalThis.window = { addEventListener: noop };
globalThis.DOMPurify = { sanitize: (s) => s, addHook: noop };
globalThis.marked = { parse: (s) => s, setOptions: noop, use: noop };

const { MarkdownRenderer } = await import("../../web/js/services/markdown_renderer.js");

const collapse = (text) => MarkdownRenderer.collapseRuleRuns(text);

test("a long run of dash-space becomes a rule, not a thousand list items", () => {
  // The real case: one page of a filing came back with 6,402 characters of
  // "- - - - ", which Markdown reads as bullet after bullet after bullet.
  const artefact = "- ".repeat(3200).trim();
  assert.equal(collapse(artefact), "---");
});

test("a long run of any separator character collapses", () => {
  assert.equal(collapse("-".repeat(200)), "---");
  assert.equal(collapse(".".repeat(40)), "---");
  assert.equal(collapse("_".repeat(60)), "---");
  assert.equal(collapse("·".repeat(30)), "---");
});

test("a real list item is left alone", () => {
  assert.equal(collapse("- a real list item"), "- a real list item");
  assert.equal(collapse("- short"), "- short");
});

test("an ordinary horizontal rule is left alone", () => {
  assert.equal(collapse("---"), "---");
  assert.equal(collapse("- - -"), "- - -");
});

test("prose containing dashes is untouched", () => {
  const prose = "Profit was 4.2m - up on last year and steady - as expected across the group";
  assert.equal(collapse(prose), prose);
});

test("a table separator row survives", () => {
  // Long enough to trip the length check, but it is structure, not scenery.
  const row = "| ------------- | ------------- | ------------- |";
  assert.equal(collapse(row), row);
});

test("indentation and surrounding lines are preserved", () => {
  const input = ["Signed,", "  " + "-".repeat(80), "Director"].join("\n");
  assert.equal(collapse(input), ["Signed,", "---", "Director"].join("\n"));
});

test("nothing in, nothing out", () => {
  assert.equal(collapse(""), "");
  assert.equal(collapse(null), null);
});
