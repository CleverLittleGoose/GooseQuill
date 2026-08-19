/**
 * GooseQuill — Virtualised Transcript View
 *
 * Renders a converted document one page at a time into a windowed list, instead
 * of committing the whole transcript to the DOM at once.
 *
 * A 214-page filing rendered as a single innerHTML produced ~605,000px of
 * layout. Scrolling it was heavy, and an in-document search injected 6,741
 * <mark> nodes and blocked the main thread for about a second per keystroke.
 * Here each page is its own <section>: only pages near the viewport hold real
 * DOM, and the rest stand in at their measured height so the scrollbar never
 * lies and scroll position never jumps.
 *
 * Search deliberately does NOT walk the DOM. It runs over a per-page text index
 * built off the main thread's critical path, so matches on page 200 are found
 * without that page ever being rendered; only the match being visited is
 * highlighted.
 */

import { markdownRenderer } from "./markdown_renderer.js";

// Pages this far outside the viewport (in px) are kept rendered. Generous
// enough that ordinary scrolling never reveals a blank placeholder.
const RENDER_MARGIN_PX = 2000;

// Rough px-per-character, used only until a page has been measured once.
// Derived from real filings; being wrong just means the scrollbar settles
// slightly as pages are visited.
const ESTIMATED_PX_PER_CHAR = 0.8;
const MIN_ESTIMATED_PAGE_HEIGHT = 320;

export class TranscriptView {
  /**
   * @param {HTMLElement} pane    the scrolling element
   * @param {HTMLElement} content the element to fill with page sections
   * @param {{onActivePageChange?: (page:number)=>void}} options
   */
  constructor(pane, content, options = {}) {
    this.pane = pane;
    this.content = content;
    this.onActivePageChange = options.onActivePageChange || (() => {});

    this.pagesMap = {};
    this.pageNumbers = [];
    this.sections = new Map();      // page -> <section>
    this.measuredHeights = new Map();
    this.renderedPages = new Set();
    this.textIndex = new Map();     // page -> plain text, for searching
    this.activePage = 1;

    this.searchQuery = "";
    this.searchMatchCase = false;
    this.searchHits = [];           // [{page, ordinal}]
    this.currentHitIndex = -1;
    this.highlightedSection = null;

    this._indexHandle = null;
    this._suppressActivePageEvents = false;

    this.observer = new IntersectionObserver((entries) => this._onIntersect(entries), {
      root: this.pane,
      rootMargin: `${RENDER_MARGIN_PX}px 0px`,
      threshold: 0
    });
  }

  /**
   * Swap in a document. `pagesMap` is {pageNumber: markdownForThatPage}.
   */
  setDocument(pagesMap, { restrictToPage = null, renderPage = null, pageLabels = null } = {}) {
    this._cancelIndexing();
    this.observer.disconnect();

    this.pagesMap = pagesMap || {};
    // Lets a caller supply its own HTML per page — diff mode renders annotated
    // pages this way and inherits the windowing for free.
    this.renderPage = renderPage;
    // Keys are positions, not always page numbers. A consolidated document
    // restarts at page 1 for every source file, so it keys blocks by position
    // and says here what each block should actually be called.
    this.pageLabels = pageLabels;
    this.pageNumbers = Object.keys(this.pagesMap)
      .filter((key) => /^\d+$/.test(key))   // skips the "preamble" entry
      .map((n) => parseInt(n, 10))
      .sort((a, b) => a - b);

    if (restrictToPage !== null) {
      this.pageNumbers = this.pageNumbers.filter((n) => n === restrictToPage);
    }

    this.sections.clear();
    this.measuredHeights.clear();
    this.renderedPages.clear();
    this.textIndex.clear();
    this.clearSearch();

    this.content.innerHTML = "";
    const fragment = document.createDocumentFragment();

    // The converter's document header (title, source file, model) is not a
    // page; it is always present and cheap, so it renders straight away.
    if (this.pagesMap.preamble && restrictToPage === null) {
      const header = document.createElement("section");
      header.className = "tv-preamble";
      header.innerHTML = markdownRenderer.render(this.pagesMap.preamble);
      fragment.appendChild(header);
    }

    this.pageNumbers.forEach((page) => {
      const section = document.createElement("section");
      section.className = "tv-page";
      section.dataset.page = String(page);
      section.style.minHeight = `${this._estimateHeight(page)}px`;
      this.sections.set(page, section);
      fragment.appendChild(section);
      this.observer.observe(section);
    });

    this.content.appendChild(fragment);
    this._renderInitialWindow();
    this._scheduleTextIndexing();
  }

  /**
   * Render enough pages to fill the pane before the observer has said anything.
   *
   * IntersectionObserver does not deliver while the tab is backgrounded, and
   * waiting on it would leave the pane blank on first paint.
   */
  _renderInitialWindow() {
    const budget = this.pane.clientHeight + RENDER_MARGIN_PX;
    let used = 0;
    for (const page of this.pageNumbers) {
      this._renderPage(page);
      used += this.measuredHeights.get(page) || this._estimateHeight(page);
      if (used >= budget) break;
    }
  }

  _estimateHeight(page) {
    if (this.measuredHeights.has(page)) return this.measuredHeights.get(page);
    const len = (this.pagesMap[page] || "").length;
    return Math.max(MIN_ESTIMATED_PAGE_HEIGHT, Math.round(len * ESTIMATED_PX_PER_CHAR));
  }

  _onIntersect(entries) {
    entries.forEach((entry) => {
      const page = parseInt(entry.target.dataset.page, 10);
      if (Number.isNaN(page)) return;
      if (entry.isIntersecting) {
        this._renderPage(page);
      } else {
        this._releasePage(page);
      }
    });
  }

  _renderPage(page) {
    if (this.renderedPages.has(page)) return;
    const section = this.sections.get(page);
    if (!section) return;

    section.innerHTML = this._renderPageHtml(page);
    this._decoratePageHeading(section, page);
    this.renderedPages.add(page);

    // Once real content exists, pin the placeholder to its true height so
    // releasing the page later cannot shift everything below it.
    const height = section.offsetHeight;
    if (height > 0) {
      this.measuredHeights.set(page, height);
      section.style.minHeight = `${height}px`;
    }

    // A page rendered while it holds the active search hit must show it.
    if (this.currentHitIndex >= 0) {
      const hit = this.searchHits[this.currentHitIndex];
      if (hit && hit.page === page) this._highlightWithinSection(section, hit.ordinal);
    }
  }

  _renderPageHtml(page) {
    if (this.renderPage) return this.renderPage(page, this.pagesMap[page] || "");
    return markdownRenderer.render(this.pagesMap[page] || "");
  }

  _releasePage(page) {
    if (!this.renderedPages.has(page)) return;
    const section = this.sections.get(page);
    if (!section) return;

    // Never release the page holding the active search hit; the highlight and
    // the user's sense of place both live in it.
    if (this.currentHitIndex >= 0) {
      const hit = this.searchHits[this.currentHitIndex];
      if (hit && hit.page === page) return;
    }

    const height = section.offsetHeight;
    if (height > 0) this.measuredHeights.set(page, height);
    section.style.minHeight = `${this.measuredHeights.get(page) || this._estimateHeight(page)}px`;
    section.innerHTML = "";
    this.renderedPages.delete(page);
  }

  /** What this block calls itself, which is not always its key. */
  _pageLabel(page) {
    return this.pageLabels ? this.pageLabels[page] ?? String(page) : String(page);
  }

  /** Give the page's own heading its badge, as the flat renderer used to. */
  _decoratePageHeading(section, page) {
    const heading = section.querySelector("h1, h2, h3, h4, h5, h6");
    if (!heading) {
      // Custom-rendered pages (diff mode) carry no markdown heading, but the
      // reader still needs to know which page they are looking at.
      if (!section.querySelector(".doc-page-badge")) {
        const standalone = document.createElement("div");
        standalone.className = "doc-page-heading tv-page-marker";
        standalone.innerHTML = `<span class="doc-page-badge">PAGE ${this._pageLabel(page)}</span>`;
        section.insertBefore(standalone, section.firstChild);
      }
      return;
    }
    if (heading.querySelector(".doc-page-badge")) return;
    heading.classList.add("doc-page-heading");
    const badge = document.createElement("span");
    badge.className = "doc-page-badge";
    badge.textContent = `PAGE ${this._pageLabel(page)}`;
    heading.appendChild(badge);
  }

  /* ---------------------------------------------------------------- paging */

  /**
   * Which page currently sits at the top of the viewport.
   */
  computeActivePage() {
    const paneRect = this.pane.getBoundingClientRect();
    const threshold = paneRect.top + 120;

    let active = this.pageNumbers[0] || 1;
    for (const page of this.pageNumbers) {
      const section = this.sections.get(page);
      if (!section) continue;
      if (section.getBoundingClientRect().top <= threshold) active = page;
      else break;
    }
    return active;
  }

  /** Recompute the active page and notify, unless we are moving the pane ourselves. */
  syncActivePageFromScroll() {
    if (this._suppressActivePageEvents) return;
    const page = this.computeActivePage();
    if (page !== this.activePage) {
      this.activePage = page;
      this.onActivePageChange(page);
    }
  }

  /**
   * Put a page at the top of the pane.
   *
   * Placeholders mean the target's offset can shift as neighbours render, so
   * the position is applied, allowed to settle, then corrected.
   */
  scrollToPage(page) {
    const section = this.sections.get(page);
    if (!section) return;

    this.activePage = page;
    this._suppressActivePageEvents = true;

    const apply = () => {
      const paneRect = this.pane.getBoundingClientRect();
      const top = this.pane.scrollTop + (section.getBoundingClientRect().top - paneRect.top);
      this.pane.scrollTop = Math.max(0, Math.min(top, this.pane.scrollHeight - this.pane.clientHeight));
    };

    apply();
    this._renderPage(page);
    requestAnimationFrame(() => {
      apply();
      requestAnimationFrame(() => {
        apply();
        this._suppressActivePageEvents = false;
      });
    });
  }

  /* ---------------------------------------------------------------- search */

  /**
   * Build the per-page plain-text index in idle slices.
   *
   * Searching needs text from pages that are not rendered, and parsing 214
   * pages in one go would stall the interface just as badly as the old
   * approach did.
   */
  _scheduleTextIndexing() {
    const queue = [...this.pageNumbers];
    const scratch = document.createElement("div");

    // Always clear a minimum batch. When requestIdleCallback fires because its
    // timeout expired rather than because the browser is idle, timeRemaining()
    // is 0 — honouring that alone means every slice does nothing and indexing
    // never finishes.
    const MIN_PAGES_PER_SLICE = 8;
    const MAX_PAGES_PER_SLICE = 40;

    const runSlice = (deadline) => {
      const hasTime = () => (deadline && deadline.timeRemaining ? deadline.timeRemaining() > 4 : true);
      let processed = 0;

      while (
        queue.length &&
        processed < MAX_PAGES_PER_SLICE &&
        (processed < MIN_PAGES_PER_SLICE || hasTime())
      ) {
        const page = queue.shift();
        scratch.innerHTML = this._renderPageHtml(page);
        this.textIndex.set(page, scratch.textContent || "");
        processed++;
      }

      if (queue.length) {
        this._indexHandle = this._requestIdle(runSlice);
      } else {
        this._indexHandle = null;
        scratch.innerHTML = "";
        // A search typed before indexing finished only saw part of the
        // document; redo it now that every page is known.
        if (this.searchQuery) this.search(this.searchQuery, this.searchMatchCase, { keepPosition: true });
      }
    };

    this._indexHandle = this._requestIdle(runSlice);
  }

  /**
   * Finish indexing right now, for any page the idle pre-warm has not reached.
   *
   * The pre-warm is an optimisation, not a guarantee: requestIdleCallback is
   * throttled to a standstill in a background tab, and a search that counted
   * only the pages indexed so far would quietly under-report — 675 matches
   * where the document holds 6,741. Correctness wins; the cost is a one-off
   * few hundred milliseconds on the first search of a large document.
   */
  _ensureIndexComplete() {
    const missing = this.pageNumbers.filter((page) => !this.textIndex.has(page));
    if (missing.length === 0) return;

    const scratch = document.createElement("div");
    for (const page of missing) {
      scratch.innerHTML = this._renderPageHtml(page);
      this.textIndex.set(page, scratch.textContent || "");
    }
    scratch.innerHTML = "";
    this._cancelIndexing();
  }

  _requestIdle(fn) {
    if (typeof window.requestIdleCallback === "function" && !document.hidden) {
      return { type: "idle", id: window.requestIdleCallback(fn, { timeout: 500 }) };
    }
    // Hidden tabs never go "idle" in the callback's sense, but timers still run.
    return { type: "timeout", id: setTimeout(() => fn(null), 32) };
  }

  _cancelIndexing() {
    if (!this._indexHandle) return;
    if (this._indexHandle.type === "idle" && typeof window.cancelIdleCallback === "function") {
      window.cancelIdleCallback(this._indexHandle.id);
    } else if (this._indexHandle.type === "timeout") {
      clearTimeout(this._indexHandle.id);
    }
    this._indexHandle = null;
  }

  /**
   * Locate every occurrence across the document.
   * @returns {{total:number, indexing:boolean}}
   */
  search(query, matchCase = false, { keepPosition = false } = {}) {
    const previousHit = keepPosition ? this.searchHits[this.currentHitIndex] : null;

    this._clearHighlight();
    this.searchQuery = (query || "").trim();
    this.searchMatchCase = matchCase;
    this.searchHits = [];
    this.currentHitIndex = -1;

    if (!this.searchQuery) return { total: 0, indexing: false };

    this._ensureIndexComplete();

    const pattern = new RegExp(escapeRegExp(this.searchQuery), matchCase ? "g" : "gi");

    for (const page of this.pageNumbers) {
      const text = this.textIndex.get(page);
      if (!text) continue;
      pattern.lastIndex = 0;
      let ordinal = 0;
      while (pattern.exec(text) !== null) {
        this.searchHits.push({ page, ordinal });
        ordinal++;
        if (pattern.lastIndex === 0) break;
      }
    }

    if (previousHit) {
      const resumeAt = this.searchHits.findIndex(
        (h) => h.page === previousHit.page && h.ordinal === previousHit.ordinal
      );
      if (resumeAt >= 0) this.currentHitIndex = resumeAt;
    }

    return { total: this.searchHits.length, indexing: false };
  }

  /** Move to a hit by absolute index, scrolling and highlighting it. */
  goToHit(index) {
    if (index < 0 || index >= this.searchHits.length) return null;

    this._clearHighlight();
    this.currentHitIndex = index;
    const hit = this.searchHits[index];

    this.scrollToPage(hit.page);
    const section = this.sections.get(hit.page);
    if (section) {
      this._renderPage(hit.page);
      const mark = this._highlightWithinSection(section, hit.ordinal);
      if (mark) {
        const paneRect = this.pane.getBoundingClientRect();
        const top =
          this.pane.scrollTop +
          (mark.getBoundingClientRect().top - paneRect.top) -
          this.pane.clientHeight / 2;
        this._suppressActivePageEvents = true;
        this.pane.scrollTop = Math.max(0, Math.min(top, this.pane.scrollHeight - this.pane.clientHeight));
        requestAnimationFrame(() => {
          this._suppressActivePageEvents = false;
        });
      }
    }
    return hit;
  }

  nextHit(direction = 1) {
    if (this.searchHits.length === 0) return null;
    const count = this.searchHits.length;
    const next = (this.currentHitIndex + direction + count) % count;
    return this.goToHit(next);
  }

  /**
   * Wrap the nth occurrence inside one already-rendered page.
   * Scoped to a single section, so this stays cheap however long the document is.
   */
  _highlightWithinSection(section, ordinal) {
    if (!this.searchQuery) return null;

    // goToHit renders the page (which highlights) and then highlights again;
    // without this the same match ends up wrapped twice.
    this._stripMarks(section);

    const walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_SKIP;
        const parent = node.parentElement;
        if (parent && (parent.tagName === "SCRIPT" || parent.tagName === "STYLE" || parent.classList.contains("doc-page-badge"))) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const pattern = new RegExp(escapeRegExp(this.searchQuery), this.searchMatchCase ? "g" : "gi");
    let seen = 0;
    let node;

    while ((node = walker.nextNode())) {
      const text = node.nodeValue;
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        if (seen === ordinal) {
          const mark = wrapRange(node, match.index, match.index + match[0].length);
          if (mark) {
            mark.classList.add("viewer-search-match", "viewer-search-match-active");
            this.highlightedSection = section;
          }
          return mark;
        }
        seen++;
        if (pattern.lastIndex === match.index) pattern.lastIndex++;
      }
    }
    return null;
  }

  _clearHighlight() {
    const section = this.highlightedSection;
    this.highlightedSection = null;
    if (section) this._stripMarks(section);
  }

  /** Unwrap every search mark inside one section, restoring the plain text. */
  _stripMarks(section) {
    section.querySelectorAll("mark.viewer-search-match").forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(mark.textContent), mark);
      parent.normalize();
    });
  }

  clearSearch() {
    this._clearHighlight();
    this.searchQuery = "";
    this.searchHits = [];
    this.currentHitIndex = -1;
  }

  /** Page number of the hit currently being visited, or null. */
  getCurrentHitPage() {
    const hit = this.searchHits[this.currentHitIndex];
    return hit ? hit.page : null;
  }

  destroy() {
    this._cancelIndexing();
    this.observer.disconnect();
    this.sections.clear();
    this.renderedPages.clear();
    this.textIndex.clear();
    this.content.innerHTML = "";
  }
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Split a text node so [start,end) sits inside a fresh <mark>. */
function wrapRange(node, start, end) {
  const text = node.nodeValue;
  const parent = node.parentNode;
  if (!parent) return null;

  const before = text.slice(0, start);
  const middle = text.slice(start, end);
  const after = text.slice(end);

  const mark = document.createElement("mark");
  mark.textContent = middle;

  const fragment = document.createDocumentFragment();
  if (before) fragment.appendChild(document.createTextNode(before));
  fragment.appendChild(mark);
  if (after) fragment.appendChild(document.createTextNode(after));

  parent.replaceChild(fragment, node);
  return mark;
}
