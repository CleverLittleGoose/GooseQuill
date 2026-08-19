/**
 * Splitting an assembled document back into pages.
 *
 * This is the seam every reading surface depends on: the Studio transcript, the
 * compare pane and the consolidated preview all ask this module which text
 * belongs to which page. It used to exist as two near-identical copies in two
 * components, which is why it is worth pinning down here.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { parsePages, pageNumbersOf, splitSequential } from "../../web/js/services/page_splitter.js";

const HEADER = "# Northwind Properties PLC\n\nSource Document: `x.pdf`\n";

test("no page markers at all is one page, not no pages", () => {
  const pages = parsePages("Just some text with no markers.");
  assert.deepEqual(pages, { 1: "Just some text with no markers." });
});

test("empty input yields no pages rather than throwing", () => {
  assert.deepEqual(parsePages(""), {});
  assert.deepEqual(parsePages(null), {});
  assert.deepEqual(parsePages(undefined), {});
});

test("the document header before the first marker is kept as preamble", () => {
  const pages = parsePages(`${HEADER}\n<!-- Page 1 -->\n## Page 1\nFirst page body.`);
  assert.equal(pages.preamble, HEADER.trim());
  assert.match(pages[1], /First page body\./);
});

test("a document with no header has no preamble key", () => {
  const pages = parsePages("<!-- Page 1 -->\n## Page 1\nBody.");
  assert.ok(!("preamble" in pages));
});

test("the marker and its heading form one page, not two", () => {
  // The assembler writes both forms. Treated as two splits, page 1 is cut in
  // half and the surviving half loses the comment marker the fence unwrapper
  // keys on — the bug this dedupe exists to prevent.
  const pages = parsePages("<!-- Page 1 -->\n## Page 1\nBody of one.\n<!-- Page 2 -->\n## Page 2\nBody of two.");
  assert.deepEqual(pageNumbersOf(pages), [1, 2]);
  assert.match(pages[1], /Body of one\./);
  assert.match(pages[1], /<!-- Page 1 -->/, "the comment marker must survive on the page");
  assert.match(pages[2], /Body of two\./);
});

test("either marker form alone opens a page", () => {
  assert.deepEqual(pageNumbersOf(parsePages("<!-- Page 4 -->\nOnly a comment marker.")), [4]);
  assert.deepEqual(pageNumbersOf(parsePages("## Page 7\nOnly a heading.")), [7]);
});

test("a trailing rule is a page separator, not page content", () => {
  const pages = parsePages("<!-- Page 1 -->\nBody.\n\n---\n<!-- Page 2 -->\nMore.");
  assert.equal(pages[1].endsWith("---"), false);
  assert.match(pages[1], /Body\.$/);
});

test("pages are keyed by the number the document claims, not by position", () => {
  // A filing split across a batch can start at page 40.
  const pages = parsePages("<!-- Page 40 -->\nForty.\n<!-- Page 41 -->\nForty-one.");
  assert.deepEqual(pageNumbersOf(pages), [40, 41]);
});

test("pageNumbersOf sorts numerically and ignores the preamble", () => {
  const pages = { preamble: "x", 2: "b", 10: "j", 1: "a" };
  assert.deepEqual(pageNumbersOf(pages), [1, 2, 10]);
});

test("pageNumbersOf tolerates nothing at all", () => {
  assert.deepEqual(pageNumbersOf(null), []);
  assert.deepEqual(pageNumbersOf({}), []);
});

/* ------------------------------------------------------- consolidated files */

test("a consolidated file keeps every document's page 1", () => {
  // Keyed by page number, the second document's page 1 would overwrite the
  // first's and a page of the combined document would silently vanish.
  const combined = [
    "# Consolidated",
    "<!-- Page 1 -->\n## Page 1\nDoc A page one.",
    "<!-- Page 2 -->\n## Page 2\nDoc A page two.",
    "<!-- Page 1 -->\n## Page 1\nDoc B page one."
  ].join("\n");

  const { pages, labels } = splitSequential(combined);

  assert.deepEqual(pageNumbersOf(pages), [1, 2, 3], "three blocks, keyed by position");
  assert.match(pages[1], /Doc A page one\./);
  assert.match(pages[2], /Doc A page two\./);
  assert.match(pages[3], /Doc B page one\./);
  assert.deepEqual(labels, { 1: "1", 2: "2", 3: "1" }, "each block still says which page it is");
});

test("the consolidated master title is carried as preamble", () => {
  const { pages } = splitSequential("# Consolidated Report\n\nContents…\n\n<!-- Page 1 -->\nBody.");
  assert.match(pages.preamble, /Consolidated Report/);
});

test("splitSequential handles a file with no markers", () => {
  const { pages, labels } = splitSequential("No markers here.");
  assert.deepEqual(pages, { 1: "No markers here." });
  assert.deepEqual(labels, { 1: "1" });
});

test("splitSequential handles nothing at all", () => {
  assert.deepEqual(splitSequential(""), { pages: {}, labels: {} });
});
