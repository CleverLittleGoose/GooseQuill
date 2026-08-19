/**
 * GooseQuill — highlighting a search hit inside a rendered page
 *
 * `_highlightWithinSection` is the last part of the transcript view the rest of
 * the suite cannot reach. It walks the section's real text nodes with a
 * TreeWalker, counts occurrences across them, and splits the one it wants out
 * of its node into a <mark>. The hand-rolled DOM in transcript_view.test.mjs
 * deliberately stops short of that: a faked TreeWalker would only test the fake.
 *
 * So this file, and only this file, uses jsdom.
 *
 * WHY THAT DOES NOT COST ANYTHING
 *
 * jsdom is a devDependency in the root package.json. GooseQuill is a Python app
 * serving static files to a browser — it never imports jsdom, never runs Node,
 * and does not need it installed to run or to ship. If it is absent the tests
 * below skip with a note instead of failing, so `./test.sh` still passes on a
 * clean checkout with nothing installed, exactly as it did before. Run
 * `npm install` once to have them actually execute.
 *
 * WHAT IS ACTUALLY UNDER TEST
 *
 * Not the TreeWalker — that is the browser's, and jsdom's implementation of it
 * is assumed correct. What is ours, and what has room to be wrong, is: the
 * filter that decides which text counts, the ordinal arithmetic that picks the
 * nth match across several nodes, the pattern built from the user's query, and
 * the node surgery that must not lose the text around the match.
 */

import test from "node:test";
import assert from "node:assert/strict";

let JSDOM = null;
try {
  ({ JSDOM } = await import("jsdom"));
} catch {
  // Left null: every test below turns into a skip.
}

const needsJsdom = JSDOM
  ? false
  : "jsdom is not installed — run `npm install` to run the highlighting tests";

/* ------------------------------------------------------------------ the DOM */

let TranscriptView = null;

if (JSDOM) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  const { window } = dom;

  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.NodeFilter = window.NodeFilter;
  globalThis.Node = window.Node;
  globalThis.requestAnimationFrame = (fn) => { fn(); return 0; };

  // The view schedules its text indexing through these. Nothing here asserts on
  // indexing, so they run inline and finish before the test continues.
  window.requestIdleCallback = (fn) => { fn({ timeRemaining: () => 50 }); return 1; };
  window.cancelIdleCallback = () => {};

  // jsdom has no IntersectionObserver. The tests below render pages directly
  // rather than by scrolling, so it only has to exist.
  globalThis.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

  // Pages here are supplied as HTML through the renderPage hook, so the
  // markdown pipeline is never reached. These satisfy the module's imports.
  globalThis.marked = { parse: (s) => s, setOptions() {}, use() {} };
  globalThis.DOMPurify = { sanitize: (s) => s, addHook() {} };

  ({ TranscriptView } = await import("../../web/js/services/transcript_view.js"));
}

/* ----------------------------------------------------------------- fixtures */

/**
 * A view holding one page of the given HTML, rendered and ready to highlight.
 *
 * The page is delivered through `renderPage` so the markup under the walker is
 * exactly what the test wrote — element boundaries and all, since where the
 * text nodes fall is the whole point.
 */
function mount(html, { query = "", matchCase = false } = {}) {
  const pane = document.createElement("div");
  const content = document.createElement("div");
  pane.appendChild(content);
  document.body.appendChild(pane);

  const view = new TranscriptView(pane, content, {});
  view.setDocument({ 1: "source" }, { renderPage: () => html });

  const section = view.sections.get(1);
  view._renderPage(1);

  view.searchQuery = query;
  view.searchMatchCase = matchCase;

  return { view, section };
}

/** The marks in a section, in document order, as text. */
const marksIn = (section) =>
  [...section.querySelectorAll("mark")].map((m) => m.textContent);

/**
 * The page's own text, without the "PAGE 1" marker the view stamps into every
 * section. Assertions about text surviving the split are about the prose; the
 * marker is the view's own furniture and is covered by its own test below.
 */
const proseOf = (section) =>
  [...section.querySelectorAll("p")].map((el) => el.textContent).join("");

/* ------------------------------------------------------- counting the matches */

test("the nth occurrence is the one marked", { skip: needsJsdom }, () => {
  const { view, section } = mount("<p>alpha beta alpha gamma alpha</p>", { query: "alpha" });

  const mark = view._highlightWithinSection(section, 1);

  assert.ok(mark, "the second occurrence exists and should have been found");
  assert.equal(marksIn(section).length, 1, "only the hit being visited is marked");
  // Which "alpha" it is cannot be told from its own text, so check what follows.
  assert.equal(proseOf(section), "alpha beta alpha gamma alpha",
    "the surrounding text survives the split");
  assert.equal(mark.nextSibling.textContent, " gamma alpha",
    "the mark landed on the second occurrence, not the first or the third");
});

test("occurrences are counted across element boundaries, not restarted in each", { skip: needsJsdom }, () => {
  // One match per paragraph, so the ordinal can only be right if the walk
  // carries its count from one text node to the next.
  const { view, section } = mount(
    "<p>alpha one</p><p>alpha two</p><p>alpha three</p>", { query: "alpha" });

  const mark = view._highlightWithinSection(section, 2);

  assert.ok(mark);
  assert.equal(mark.parentElement.textContent, "alpha three",
    "the third match is in the third paragraph");
});

test("a match split across nested elements counts once per text node", { skip: needsJsdom }, () => {
  const { view, section } = mount(
    "<p>total <strong>total</strong> <em>total</em></p>", { query: "total" });

  assert.equal(view._highlightWithinSection(section, 0).parentElement.tagName, "P");
  view._stripMarks(section);
  assert.equal(view._highlightWithinSection(section, 1).parentElement.tagName, "STRONG");
  view._stripMarks(section);
  assert.equal(view._highlightWithinSection(section, 2).parentElement.tagName, "EM");
});

test("asking for a hit that is not there returns nothing rather than the last one", { skip: needsJsdom }, () => {
  const { view, section } = mount("<p>alpha beta</p>", { query: "alpha" });

  assert.equal(view._highlightWithinSection(section, 5), null);
  assert.equal(marksIn(section).length, 0, "nothing is marked when nothing matched");
});

test("with no query nothing is walked and nothing is marked", { skip: needsJsdom }, () => {
  const { view, section } = mount("<p>alpha beta</p>", { query: "" });

  assert.equal(view._highlightWithinSection(section, 0), null);
  assert.equal(marksIn(section).length, 0);
});

/* ------------------------------------------------- what counts as searchable */

test("the page badge is not searchable text", { skip: needsJsdom }, () => {
  /*
   * The view stamps "PAGE 3" into every page's heading. Without the filter that
   * rejects it, searching for "PAGE" would match a badge the reader never typed
   * and cannot see as prose — and worse, it would shift the ordinal of every
   * real match after it.
   */
  const { view, section } = mount(
    '<h2 class="doc-page-heading">Report<span class="doc-page-badge">PAGE 3</span></h2>' +
    "<p>PAGE of the annual return</p>",
    { query: "PAGE" });

  const mark = view._highlightWithinSection(section, 0);

  assert.ok(mark, "the one in the prose is the first match");
  assert.equal(mark.parentElement.tagName, "P",
    "the badge's own text must not have been counted as match zero");
});

test("text inside a style block is not searchable prose", { skip: needsJsdom }, () => {
  /*
   * Pages can arrive as caller-supplied HTML through the renderPage hook, which
   * does not go through the markdown sanitiser. A stylesheet's text is not
   * something the reader can see, so counting a match in it would put the
   * ordinals out of step with what is on the screen.
   */
  const { view, section } = mount(
    "<style>.total { color: red }</style><p>total assets</p>", { query: "total" });

  const mark = view._highlightWithinSection(section, 0);

  assert.ok(mark, "the prose match is the first one");
  assert.equal(mark.parentElement.tagName, "P",
    "the rule in the stylesheet must not have been counted as match zero");
});

/* ----------------------------------------------------------- the query itself */

test("matching ignores case by default", { skip: needsJsdom }, () => {
  const { view, section } = mount("<p>Alpha ALPHA alpha</p>", { query: "alpha" });

  assert.equal(view._highlightWithinSection(section, 0).textContent, "Alpha");
  view._stripMarks(section);
  assert.equal(view._highlightWithinSection(section, 1).textContent, "ALPHA",
    "the mark keeps the text as written, not as typed into the search box");
});

test("matching respects case when asked to", { skip: needsJsdom }, () => {
  const { view, section } = mount("<p>Alpha ALPHA alpha</p>", { query: "alpha", matchCase: true });

  const mark = view._highlightWithinSection(section, 0);
  assert.equal(mark.textContent, "alpha");
  assert.equal(view._highlightWithinSection(section, 1), null, "there is only one exact match");
});

test("regular-expression characters in a query are searched for literally", { skip: needsJsdom }, () => {
  // "£1.5m" would otherwise let "." match any character, so "£145m" would hit.
  const { view, section } = mount("<p>£145m then £1.5m</p>", { query: "£1.5m" });

  const mark = view._highlightWithinSection(section, 0);

  assert.ok(mark);
  assert.equal(mark.textContent, "£1.5m");
  assert.equal(mark.previousSibling.textContent, "£145m then ",
    "the literal match was found, not the earlier one the dot would have matched");
});

/* --------------------------------------------------------------- the surgery */

test("the text around a match is preserved exactly", { skip: needsJsdom }, () => {
  const { view, section } = mount("<p>before MATCH after</p>", { query: "MATCH" });

  view._highlightWithinSection(section, 0);

  assert.equal(proseOf(section), "before MATCH after",
    "splitting the node must not drop or reorder a character");
});

test("a match at the very start or end of a node keeps its node whole", { skip: needsJsdom }, () => {
  const atStart = mount("<p>alpha rest</p>", { query: "alpha" });
  atStart.view._highlightWithinSection(atStart.section, 0);
  assert.equal(proseOf(atStart.section), "alpha rest");

  const atEnd = mount("<p>rest alpha</p>", { query: "alpha" });
  atEnd.view._highlightWithinSection(atEnd.section, 0);
  assert.equal(proseOf(atEnd.section), "rest alpha");
});

test("the mark carries both the match class and the active one", { skip: needsJsdom }, () => {
  const { view, section } = mount("<p>alpha</p>", { query: "alpha" });

  const mark = view._highlightWithinSection(section, 0);

  assert.ok(mark.classList.contains("viewer-search-match"));
  assert.ok(mark.classList.contains("viewer-search-match-active"),
    "the hit being visited is styled differently from the rest");
  assert.equal(view.highlightedSection, section,
    "the view remembers where to strip the mark from later");
});

test("highlighting the same section twice does not wrap the match twice", { skip: needsJsdom }, () => {
  /*
   * goToHit renders the page — which highlights — and then highlights again.
   * Without the strip at the top of the function the second pass would find the
   * <mark> from the first and nest another inside it.
   */
  const { view, section } = mount("<p>alpha beta alpha</p>", { query: "alpha" });

  view._highlightWithinSection(section, 0);
  view._highlightWithinSection(section, 0);

  assert.equal(marksIn(section).length, 1, "one mark, not two");
  assert.equal(section.querySelectorAll("mark mark").length, 0, "and none nested");
  assert.equal(proseOf(section), "alpha beta alpha");
});

test("moving to another hit leaves only the new one marked", { skip: needsJsdom }, () => {
  const { view, section } = mount("<p>alpha beta alpha</p>", { query: "alpha" });

  view._highlightWithinSection(section, 0);
  const second = view._highlightWithinSection(section, 1);

  assert.equal(marksIn(section).length, 1);
  assert.equal(second.nextSibling, null, "the mark is on the trailing occurrence");
});

test("stripping a mark restores the text as one node again", { skip: needsJsdom }, () => {
  const { view, section } = mount("<p>before MATCH after</p>", { query: "MATCH" });

  view._highlightWithinSection(section, 0);
  view._stripMarks(section);

  const paragraph = section.querySelector("p");
  assert.equal(paragraph.childNodes.length, 1,
    "normalize() rejoins the three pieces, so the next search sees one node");
  assert.equal(paragraph.textContent, "before MATCH after");
});
