/**
 * GooseQuill — Virtualised transcript view
 *
 * The most intricate code in the app, and until now the least covered. These
 * tests are about the bookkeeping: which pages exist, how tall they are said to
 * be before and after they are measured, what the search index contains, and
 * which hit is current. That bookkeeping is where the bugs have actually been.
 *
 * WHAT THE STUB BELOW MODELS, AND WHAT IT DOES NOT
 *
 * There is no jsdom here; the frontend suite has no dependencies and this is
 * not worth acquiring one for. Instead there is just enough DOM for the view to
 * run honestly in the dimensions being asserted:
 *
 *   - `offsetHeight` returns `max(content, min-height)`, which is what a
 *     browser does and is the exact behaviour that produced the pinned-estimate
 *     bug covered below. Get this wrong and the regression test is worthless,
 *     so it is the one piece of layout modelled faithfully.
 *   - `innerHTML` is stored as a string and `textContent` is that string with
 *     tags stripped, which is all the text index ever asks of it.
 *
 * Deliberately NOT modelled, and so NOT covered here: real layout, the
 * IntersectionObserver's own scheduling (tests drive it directly), and
 * `_highlightWithinSection`, which walks real text nodes with a TreeWalker.
 * Faking a TreeWalker would only test the fake. Highlighting and virtualisation
 * under a real engine are verified in a browser instead — see
 * `.claude/verify-virtualisation.js`.
 */

import test from "node:test";
import assert from "node:assert/strict";

/* ------------------------------------------------------------------ the DOM */

/** Content is this many px per character. Distinct from the view's own 0.55
 *  estimate, so the two can be told apart in an assertion. */
const PX_PER_CHAR = 0.2;
const intrinsicHeightOf = (html) => Math.round(stripTags(html).length * PX_PER_CHAR);

function stripTags(html) {
  return String(html).replace(/<[^>]*>/g, "");
}

class ClassList {
  constructor() { this._set = new Set(); }
  add(...names) { names.forEach((n) => this._set.add(n)); }
  remove(...names) { names.forEach((n) => this._set.delete(n)); }
  contains(name) { return this._set.has(name); }
  toggle() {}
}

class Fragment {
  constructor() { this.children = []; }
  appendChild(node) { this.children.push(node); return node; }
}

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.classList = new ClassList();
    this.className = "";
    this.parentNode = null;
    this.clientHeight = 0;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.rectTop = 0;
    this._html = "";
  }

  set innerHTML(html) { this._html = String(html); this.children = []; }
  get innerHTML() { return this._html; }
  get textContent() { return stripTags(this._html); }
  set textContent(text) { this._html = String(text); }

  /** max(content, min-height) — the browser rule the view has to work around. */
  get offsetHeight() {
    const min = parseFloat(this.style.minHeight) || 0;
    return Math.max(intrinsicHeightOf(this._html), min);
  }

  getBoundingClientRect() {
    return { top: this.rectTop, bottom: this.rectTop + this.offsetHeight, height: this.offsetHeight };
  }

  appendChild(node) {
    if (node instanceof Fragment) {
      node.children.forEach((c) => { c.parentNode = this; this.children.push(c); });
      return node;
    }
    node.parentNode = this;
    this.children.push(node);
    return node;
  }

  insertBefore(node, ref) {
    const at = ref ? this.children.indexOf(ref) : -1;
    node.parentNode = this;
    if (at < 0) this.children.push(node); else this.children.splice(at, 0, node);
    return node;
  }

  get firstChild() { return this.children[0] || null; }

  // The view only asks for headings and badges. Reporting neither sends
  // _decoratePageHeading down its "no heading" path, which is inert here.
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

/** Captures the observer the view builds, so tests can deliver entries themselves. */
let observers = [];
/** Captures idle callbacks rather than running them, so indexing is opt-in. */
let idleCallbacks = [];

function installDom() {
  observers = [];
  idleCallbacks = [];

  globalThis.document = {
    hidden: false,
    addEventListener() {},
    createElement: (tag) => new El(tag),
    createDocumentFragment: () => new Fragment(),
    createTextNode: (text) => { const n = new El("#text"); n.textContent = text; return n; },
    createTreeWalker: () => ({ nextNode: () => null }),
    querySelectorAll: () => [],
    body: { appendChild() {} }
  };
  globalThis.NodeFilter = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 };
  globalThis.window = {
    addEventListener() {},
    requestIdleCallback: (fn) => { idleCallbacks.push(fn); return idleCallbacks.length; },
    cancelIdleCallback: () => {}
  };
  globalThis.requestAnimationFrame = (fn) => { fn(); return 0; };
  globalThis.IntersectionObserver = class {
    constructor(cb) { this.cb = cb; this.observed = new Set(); observers.push(this); }
    observe(el) { this.observed.add(el); }
    unobserve(el) { this.observed.delete(el); }
    disconnect() { this.observed.clear(); }
    /** Deliver entries as the browser would. */
    send(entries) { this.cb(entries); }
  };
  // Markdown passes straight through, so a page's text is its own source and
  // the index can be asserted against the input verbatim.
  globalThis.marked = { parse: (s) => s, setOptions() {}, use() {} };
  globalThis.DOMPurify = { sanitize: (s) => s, addHook() {} };
}

installDom();
const { TranscriptView } = await import("../../web/js/services/transcript_view.js");

/* ----------------------------------------------------------------- fixtures */

/** A page whose text is `word` repeated until it is `chars` long. */
const pageOf = (chars, word = "alpha ") => word.repeat(Math.ceil(chars / word.length)).slice(0, chars);

function build({ pages = 20, chars = 2000, paneHeight = 0, options = {} } = {}) {
  const pagesMap = {};
  for (let p = 1; p <= pages; p++) pagesMap[p] = pageOf(chars);
  return mount(pagesMap, { paneHeight, options });
}

function mount(pagesMap, { paneHeight = 0, options = {}, setDocumentOptions = {} } = {}) {
  const pane = new El("div");
  const content = new El("div");
  pane.clientHeight = paneHeight;
  const view = new TranscriptView(pane, content, options);
  view.setDocument(pagesMap, setDocumentOptions);
  // Runs whichever slice is currently pending: each one schedules the next.
  const idle = (timeRemaining = 50) =>
    idleCallbacks[idleCallbacks.length - 1]({ timeRemaining: () => timeRemaining });
  return { view, pane, content, observer: observers[observers.length - 1], idle };
}

/* ------------------------------------------------------- the set of pages */

test("pages come out in reading order whatever order they arrived in", () => {
  // Worth stating as a guarantee even though it is currently free: JavaScript
  // hands back integer-like object keys in ascending numeric order on its own,
  // so the view's own sort never has anything left to do. It is belt to that
  // brace — if the pages ever arrive as anything but an integer-keyed object,
  // this is the assertion that keeps them in order.
  const { view } = mount({ 11: "d", 2: "b", 10: "c", 1: "a" });
  assert.deepEqual(view.pageNumbers, [1, 2, 10, 11]);
});

test("the preamble is not a page", () => {
  const { view } = mount({ preamble: "title block", 1: "a", 2: "b" });
  assert.deepEqual(view.pageNumbers, [1, 2]);
  assert.equal(view.sections.has("preamble"), false);
});

test("restrictToPage narrows the document to the one page", () => {
  const { view } = mount({ 1: "a", 2: "b", 3: "c" }, { setDocumentOptions: { restrictToPage: 2 } });
  assert.deepEqual(view.pageNumbers, [2]);
  assert.equal(view.sections.size, 1);
});

test("a page number that is not a number is ignored", () => {
  const { view } = mount({ 1: "a", notes: "x", "2x": "y", 2: "b" });
  assert.deepEqual(view.pageNumbers, [1, 2]);
});

test("loading a second document leaves nothing of the first behind", () => {
  const { view } = build({ pages: 6 });
  view.search("alpha");
  assert.ok(view.searchHits.length > 0);

  view.setDocument({ 1: "something else entirely" });
  assert.deepEqual(view.pageNumbers, [1]);
  assert.equal(view.searchHits.length, 0);
  assert.equal(view.measuredHeights.has(3), false);
  assert.equal(view.textIndex.has(3), false);
});

/* --------------------------------------------------------------- heights */

// Page 1 alone overflows the initial window, leaving 2 and 3 unmeasured.
const unmeasured = () => mount({ 1: pageOf(20000), 2: pageOf(4000), 3: "tiny" }, { paneHeight: 0 });

test("an unmeasured page is estimated from how much text it holds", () => {
  const { view } = unmeasured();
  assert.equal(view.renderedPages.has(2), false, "page 2 must be outside the window");
  assert.equal(view._estimateHeight(2), Math.round(4000 * 0.55));
});

test("a short page still gets the minimum estimated height", () => {
  const { view } = unmeasured();
  assert.equal(view.renderedPages.has(3), false, "page 3 must be outside the window");
  assert.equal(view._estimateHeight(3), 320, "2px of text would be a nonsense placeholder");
});

test("a rendered page is measured at its true height, not at its own estimate", () => {
  // The regression. A page of 2,000 characters is estimated at 1,100px but
  // actually occupies 400px. Measured while its placeholder min-height is still
  // applied, offsetHeight can only report the larger of the two — so the
  // estimate gets laundered into a measurement and the page is followed for
  // ever by 700px of nothing.
  const { view } = build({ pages: 1, chars: 2000, paneHeight: 0 });

  assert.equal(view.renderedPages.has(1), true, "page 1 should be in the initial window");
  assert.equal(view.measuredHeights.get(1), 400, "should measure the content, not the 1,100px estimate");
  assert.equal(view.sections.get(1).style.minHeight, "400px");
});

test("a measured height replaces the estimate from then on", () => {
  const { view } = build({ pages: 1, chars: 2000 });
  assert.equal(view._estimateHeight(1), 400);
});

test("releasing a page holds its height open so nothing below it moves", () => {
  const { view, observer } = build({ pages: 20, chars: 2000 });
  const section = view.sections.get(1);
  assert.equal(view.renderedPages.has(1), true);

  observer.send([{ target: section, isIntersecting: false }]);

  assert.equal(view.renderedPages.has(1), false, "the page should have been released");
  assert.equal(section.innerHTML, "", "its DOM should be gone");
  assert.equal(section.style.minHeight, "400px", "but its height should be held");
  assert.equal(section.offsetHeight, 400);
});

test("a page that grew after rendering is released at the height it grew to", () => {
  // The height pinned at render time is not necessarily the height at release:
  // an image finishing its load, or a font swapping, moves it. Releasing on the
  // stale number is what leaves a gap or an overlap further down.
  const { view, observer } = build({ pages: 20, chars: 2000 });
  const section = view.sections.get(1);
  assert.equal(view.measuredHeights.get(1), 400);

  section.innerHTML = "x".repeat(4000);   // now 800px of content

  observer.send([{ target: section, isIntersecting: false }]);

  assert.equal(view.measuredHeights.get(1), 800, "the new height should have been taken");
  assert.equal(section.style.minHeight, "800px", "and held open at it");
});

test("a released page renders again when it comes back into view", () => {
  const { view, observer } = build({ pages: 20, chars: 2000 });
  const section = view.sections.get(1);

  observer.send([{ target: section, isIntersecting: false }]);
  assert.equal(view.renderedPages.has(1), false);

  observer.send([{ target: section, isIntersecting: true }]);
  assert.equal(view.renderedPages.has(1), true);
  assert.ok(section.innerHTML.length > 0);
});

test("only pages near the viewport are rendered, not the whole document", () => {
  const { view } = build({ pages: 40, chars: 2000, paneHeight: 0 });
  assert.ok(view.renderedPages.size < 40, "the point of the exercise");
  assert.ok(view.renderedPages.size > 0, "but the pane must not be blank either");
  assert.equal(view.sections.size, 40, "every page still has a placeholder");
});

/* ---------------------------------------------------------------- indexing */

test("the index is not built until something idle-time runs", () => {
  const { view } = build({ pages: 20 });
  assert.equal(view.textIndex.size, 0);
  assert.equal(idleCallbacks.length > 0, true, "indexing should have been scheduled");
});

test("an idle slice fills the index", () => {
  const { view, idle } = build({ pages: 20 });
  idle(50);
  assert.ok(view.textIndex.size >= 8, "a slice should clear at least its minimum batch");
});

test("a slice with no time left still clears its minimum batch", () => {
  // requestIdleCallback firing on its timeout reports 0ms remaining. Honouring
  // that literally means every slice does nothing and indexing never finishes.
  const { view, idle } = build({ pages: 20 });
  idle(0);
  assert.equal(view.textIndex.size, 8);
});

test("slice after slice finishes the whole document", () => {
  const { view, idle } = build({ pages: 20 });
  for (let i = 0; i < 3 && view.textIndex.size < 20; i++) idle(0);
  assert.equal(view.textIndex.size, 20);
});

test("searching completes the index first, so the count is of the whole document", () => {
  // Counting only the pages indexed so far under-reported badly — 675 matches
  // where the document held 6,741.
  const { view } = build({ pages: 20, chars: 600 });
  assert.equal(view.textIndex.size, 0, "nothing indexed yet");

  const { total } = view.search("alpha");

  assert.equal(view.textIndex.size, 20, "every page should have been indexed");
  assert.equal(total, 20 * 100, "100 matches on each of 20 pages");
});

/* ------------------------------------------------------------------ search */

test("search finds matches on pages that have never been rendered", () => {
  const { view } = build({ pages: 20, chars: 600 });
  const unrendered = view.pageNumbers.filter((p) => !view.renderedPages.has(p));
  assert.ok(unrendered.length > 0, "the fixture needs pages outside the window");

  view.search("alpha");

  const last = unrendered[unrendered.length - 1];
  assert.ok(view.searchHits.some((h) => h.page === last), `expected a hit on unrendered page ${last}`);
  assert.equal(view.renderedPages.has(last), false, "and finding it should not have rendered it");
});

test("search ignores case by default and respects it when asked", () => {
  const { view } = mount({ 1: "Alpha alpha ALPHA" });
  assert.equal(view.search("alpha").total, 3);
  assert.equal(view.search("alpha", true).total, 1);
  assert.equal(view.search("ALPHA", true).total, 1);
});

test("regular-expression characters in a query are searched for literally", () => {
  const { view } = mount({ 1: "profit (loss) for the year (restated)" });
  assert.equal(view.search("(loss)").total, 1);
  assert.equal(view.search("(").total, 2);
  assert.equal(view.search(".").total, 0, "a dot should not match every character");
});

test("hits are numbered within their own page", () => {
  const { view } = mount({ 1: "alpha alpha", 2: "alpha" });
  view.search("alpha");
  assert.deepEqual(view.searchHits, [
    { page: 1, ordinal: 0 },
    { page: 1, ordinal: 1 },
    { page: 2, ordinal: 0 }
  ]);
});

test("an empty query clears the hits rather than matching everything", () => {
  const { view } = mount({ 1: "alpha" });
  view.search("alpha");
  const { total } = view.search("   ");
  assert.equal(total, 0);
  assert.deepEqual(view.searchHits, []);
  assert.equal(view.currentHitIndex, -1);
});

test("a query with no matches reports none", () => {
  const { view } = mount({ 1: "alpha" });
  assert.equal(view.search("omega").total, 0);
});

test("re-running a search can keep the reader where they were", () => {
  const { view } = mount({ 1: "alpha alpha", 2: "alpha" });
  view.search("alpha");
  view.goToHit(2);
  assert.deepEqual(view.searchHits[view.currentHitIndex], { page: 2, ordinal: 0 });

  view.search("alpha", false, { keepPosition: true });
  assert.deepEqual(view.searchHits[view.currentHitIndex], { page: 2, ordinal: 0 });

  view.search("alpha");
  assert.equal(view.currentHitIndex, -1, "without keepPosition it starts over");
});

test("stepping past the last hit comes back to the first, and vice versa", () => {
  const { view } = mount({ 1: "alpha alpha", 2: "alpha" });
  view.search("alpha");

  assert.deepEqual(view.nextHit(1), { page: 1, ordinal: 0 });
  view.goToHit(2);
  assert.deepEqual(view.nextHit(1), { page: 1, ordinal: 0 }, "forwards off the end wraps to the start");
  assert.deepEqual(view.nextHit(-1), { page: 2, ordinal: 0 }, "backwards off the start wraps to the end");
});

test("stepping through an empty result set does nothing", () => {
  const { view } = mount({ 1: "alpha" });
  view.search("omega");
  assert.equal(view.nextHit(1), null);
});

test("the current hit's page is reported, and forgotten when the search is cleared", () => {
  const { view } = mount({ 1: "alpha alpha", 2: "alpha" });
  view.search("alpha");
  view.goToHit(2);
  assert.equal(view.getCurrentHitPage(), 2);

  view.clearSearch();
  assert.equal(view.getCurrentHitPage(), null);
  assert.deepEqual(view.searchHits, []);
});

test("the page holding the active hit is not released out from under it", () => {
  const { view, observer } = build({ pages: 20, chars: 600 });
  view.search("alpha");
  const hitIndex = view.searchHits.findIndex((h) => h.page === 1);
  view.goToHit(hitIndex);

  observer.send([{ target: view.sections.get(1), isIntersecting: false }]);

  assert.equal(view.renderedPages.has(1), true, "the reader's place must survive");
});

/* ------------------------------------------------------------------ paging */

test("the active page is the last one whose top is above the threshold", () => {
  const { view, pane } = build({ pages: 5, chars: 2000 });
  pane.rectTop = 0;
  // The threshold is 120px below the top of the pane.
  view.sections.get(1).rectTop = -500;
  view.sections.get(2).rectTop = 50;
  view.sections.get(3).rectTop = 400;
  view.sections.get(4).rectTop = 900;
  view.sections.get(5).rectTop = 1400;
  assert.equal(view.computeActivePage(), 2);
});

test("a change of active page is announced once, and only on a change", () => {
  const seen = [];
  const { view, pane } = build({ pages: 5, chars: 2000, options: { onActivePageChange: (p) => seen.push(p) } });
  pane.rectTop = 0;
  view.pageNumbers.forEach((p) => { view.sections.get(p).rectTop = p === 1 ? -500 : 50; });

  view.syncActivePageFromScroll();
  view.syncActivePageFromScroll();

  assert.deepEqual(seen, [5], "the last page above the threshold, announced once");
});

test("scrolling the pane ourselves does not announce a page change", () => {
  const seen = [];
  const { view, pane } = build({ pages: 5, chars: 2000, options: { onActivePageChange: (p) => seen.push(p) } });
  pane.rectTop = 0;
  view._suppressActivePageEvents = true;
  view.sections.get(5).rectTop = 50;

  view.syncActivePageFromScroll();

  assert.deepEqual(seen, []);
});

test("scrollToPage makes the page active and renders it", () => {
  const { view } = build({ pages: 40, chars: 2000 });
  assert.equal(view.renderedPages.has(38), false, "page 38 starts outside the window");

  view.scrollToPage(38);

  assert.equal(view.activePage, 38);
  assert.equal(view.renderedPages.has(38), true);
});

test("scrolling to a page that is not in the document is ignored", () => {
  const { view } = build({ pages: 3 });
  const before = view.activePage;
  view.scrollToPage(99);
  assert.equal(view.activePage, before);
});

/* ---------------------------------------------------------------- labels */

test("a page is called by its number unless it is given a label", () => {
  const { view } = mount({ 1: "a", 2: "b" });
  assert.equal(view._pageLabel(1), "1");
});

test("a consolidated document labels blocks by what they call themselves", () => {
  // Keys are positions: every source file restarts at page 1, so position 2 may
  // well be someone else's page 1.
  const { view } = mount({ 1: "a", 2: "b" }, { setDocumentOptions: { pageLabels: { 1: "1", 2: "1" } } });
  assert.equal(view._pageLabel(2), "1");
  assert.equal(view._pageLabel(9), "9", "a position with no label falls back to itself");
});

/* --------------------------------------------------------------- teardown */

test("destroy lets go of everything it was holding", () => {
  const { view, content, observer } = build({ pages: 20 });
  assert.ok(observer.observed.size > 0);

  view.destroy();

  assert.equal(observer.observed.size, 0);
  assert.equal(view.sections.size, 0);
  assert.equal(view.renderedPages.size, 0);
  assert.equal(view.textIndex.size, 0);
  assert.equal(content.innerHTML, "");
});

test("a custom renderer is used for the page body and for its index", () => {
  // Diff mode supplies its own HTML per page and inherits the windowing.
  const pane = new El("div");
  const content = new El("div");
  const view = new TranscriptView(pane, content, {});
  view.setDocument({ 1: "raw", 2: "raw" }, { renderPage: (page) => `<div>rendered ${page}</div>` });

  assert.equal(view.sections.get(1).innerHTML, "<div>rendered 1</div>");
  view.search("rendered");
  assert.equal(view.search("rendered").total, 2);
});
