/**
 * GooseQuill — Find Within a Document
 *
 * Two search paths, because there are two things to search: the virtualised
 * rendered transcript, and the textarea behind it in raw mode. Raw mode used to
 * fall through to the rendered pane, which is `display: none` while the editor
 * is up — so search reported a match count against text the user could not see
 * and scrolled nothing.
 */

import { appState } from "../state.js";
import { studio, searchState } from "./state.js";
import * as dom from "./dom.js";
import { updatePdfPageView } from "./page_view.js";
import { updateActiveItem } from "./outline.js";

/**
 * The transcript being searched.
 *
 * Pane B has its own TranscriptView with its own index and its own hits, so
 * searching it is a matter of pointing at the right one rather than teaching
 * search about two documents.
 */
function activeView() {
  if (searchState.pane === "B") return studio.comparePane?.transcript || null;
  return studio.transcript;
}

/** Pane B only exists while Compare is on. */
function canSearchPaneB() {
  return Boolean(studio.compareEnabled && studio.comparePane && studio.comparePane.doc);
}

/** Show the A/B picker only when there is a choice, and reflect the current one. */
export function updateSearchPanePicker() {
  const picker = dom.searchPanePicker();
  const available = canSearchPaneB();

  if (!available && searchState.pane === "B") setSearchPane("A");
  if (picker) picker.style.display = available ? "inline-flex" : "none";

  dom.searchPaneButtons().forEach((btn) => {
    const isActive = btn.dataset.pane === searchState.pane;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-pressed", String(isActive));
  });
}

export function setSearchPane(pane) {
  if (pane === "B" && !canSearchPaneB()) return;
  if (searchState.pane === pane) return;

  // Hits belong to the document they were found in; clear before moving.
  studio.transcript?.clearSearch();
  studio.comparePane?.transcript?.clearSearch();

  searchState.pane = pane;
  updateSearchPanePicker();

  if (searchState.query) performSearch(searchState.query, searchState.matchCase);
}

function setCount(text) {
  const el = dom.searchCount();
  if (el) el.textContent = text;
}

function setNavEnabled(enabled) {
  dom.searchNavButtons().forEach((btn) => (btn.disabled = !enabled));
}

export function openSearchBar() {
  searchState.isOpen = true;
  updateSearchPanePicker();

  const bar = dom.searchBar();
  const input = dom.searchInput();
  if (bar) bar.style.display = "flex";
  dom.searchToggleBtn()?.classList.add("active");

  if (input) {
    input.focus();
    input.select();
    if (input.value) performSearch(input.value, searchState.matchCase);
  }
}

export function closeSearchBar() {
  searchState.isOpen = false;
  searchState.query = "";
  searchState.rawMatches = [];
  searchState.currentIndex = -1;

  const bar = dom.searchBar();
  if (bar) bar.style.display = "none";
  dom.searchToggleBtn()?.classList.remove("active");
  setCount("0/0");
  setNavEnabled(false);

  studio.transcript?.clearSearch();
  studio.comparePane?.transcript?.clearSearch();
  clearStraySearchHighlights();
}

export function toggleSearchBar() {
  searchState.isOpen ? closeSearchBar() : openSearchBar();
}

export function toggleMatchCase() {
  searchState.matchCase = !searchState.matchCase;
  const btn = dom.searchCaseBtn();
  if (btn) {
    btn.classList.toggle("active", searchState.matchCase);
    btn.setAttribute("aria-pressed", searchState.matchCase ? "true" : "false");
  }
  performSearch(dom.searchInput()?.value || searchState.query || "", searchState.matchCase);
}

export function handleSearchInput(value) {
  clearTimeout(searchState.debounceTimer);
  searchState.debounceTimer = setTimeout(() => performSearch(value, searchState.matchCase), 120);
}

export function handleSearchKeydown(event) {
  if (event.key === "Enter") {
    event.preventDefault();
    navigateMatch(event.shiftKey ? -1 : 1);
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeSearchBar();
  }
}

export function performSearch(query, matchCase = false) {
  searchState.query = (query || "").trim();

  // The raw editor is pane A's Markdown; there is no textarea for pane B.
  if (studio.format === "raw" && searchState.pane === "A") {
    performRawSearch(searchState.query, matchCase, dom.rawTextarea());
    return;
  }

  const view = activeView();
  if (!view) return;

  if (!searchState.query) {
    view.clearSearch();
    setCount("0/0");
    setNavEnabled(false);
    return;
  }

  // Matching runs over a per-page text index rather than the DOM, so pages
  // that were never rendered still count — and only the visited match is
  // wrapped, instead of thousands of <mark> nodes at once.
  const { total, indexing } = view.search(searchState.query, matchCase);

  if (total === 0) {
    setCount(indexing ? "indexing…" : "0 matches");
    setNavEnabled(false);
    return;
  }

  setNavEnabled(true);
  view.goToHit(0);
  syncCountFromView(view);
}

export function navigateMatch(direction = 1) {
  if (studio.format === "raw" && searchState.pane === "A") {
    const count = searchState.rawMatches.length;
    if (count === 0) return;
    activateRawMatch((searchState.currentIndex + direction + count) % count);
    return;
  }

  const view = activeView();
  if (!view || view.searchHits.length === 0) return;
  view.nextHit(direction);
  syncCountFromView(view);
}

/** Mirror the view's search position into the toolbar, and follow it with the scan. */
function syncCountFromView(view) {
  setCount(`${view.currentHitIndex + 1} of ${view.searchHits.length}`);

  // Only pane A drives the shared page state; a hit in B moves B alone.
  const page = view.getCurrentHitPage();
  if (!page) return;

  if (searchState.pane === "B") {
    studio.comparePane?.goToPage(page);
    return;
  }

  if (page !== appState.currentPdfPage && page >= 1 && page <= appState.totalPdfPages) {
    appState.currentPdfPage = page;
    updatePdfPageView();
    updateActiveItem();
  }
}

/* ------------------------------------------------------------------ raw mode */

function performRawSearch(query, matchCase, textarea) {
  searchState.rawMatches = [];
  searchState.currentIndex = -1;

  const trimmed = (query || "").trim();
  if (!trimmed || !textarea) {
    setCount("0/0");
    setNavEnabled(false);
    return;
  }

  const regex = new RegExp(escapeRegExp(trimmed), matchCase ? "g" : "gi");
  const text = textarea.value;
  let match;
  while ((match = regex.exec(text)) !== null) {
    searchState.rawMatches.push({ start: match.index, end: match.index + match[0].length });
    if (match.index === regex.lastIndex) regex.lastIndex++;
  }

  if (searchState.rawMatches.length === 0) {
    setCount("0 matches");
    setNavEnabled(false);
    return;
  }

  setNavEnabled(true);
  // Typing is not navigating. Taking focus here put the caret in the document
  // after every keystroke, so the next letter was typed into the transcript
  // instead of the find box — and in the raw editor that is an edit.
  activateRawMatch(0, { takeFocus: false });
}

/**
 * Show one raw-mode match.
 *
 * @param {{takeFocus?: boolean}} options — whether to move the caret into the
 *   editor. True when the user asked to go to a match (Enter, or the arrows);
 *   false when the list simply changed underneath them as they typed.
 */
function activateRawMatch(index, { takeFocus = true } = {}) {
  const textarea = dom.rawTextarea();
  const match = searchState.rawMatches[index];
  if (!textarea || !match) return;

  searchState.currentIndex = index;
  setCount(`${index + 1} of ${searchState.rawMatches.length}`);

  textarea.scrollTop = Math.max(0, measureTextareaOffsetTop(textarea, match.start) - textarea.clientHeight / 2);

  if (!takeFocus) return;

  // Focus first: an unfocused textarea shows no selection, so the match would
  // be scrolled to but invisible.
  textarea.focus();
  textarea.setSelectionRange(match.start, match.end);
}

/**
 * Measure where a character offset lands inside a textarea, accounting for soft
 * wrapping, by laying the same text out in a hidden mirror with the same metrics.
 */
function measureTextareaOffsetTop(textarea, index) {
  const cs = getComputedStyle(textarea);
  const mirror = document.createElement("div");

  [
    "fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight",
    "letterSpacing", "textTransform", "textIndent", "padding", "border",
    "boxSizing", "tabSize"
  ].forEach((prop) => {
    mirror.style[prop] = cs[prop];
  });

  Object.assign(mirror.style, {
    position: "absolute",
    visibility: "hidden",
    pointerEvents: "none",
    top: "0",
    left: "-9999px",
    height: "auto",
    width: `${textarea.clientWidth}px`,
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word"
  });

  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  mirror.appendChild(document.createTextNode(textarea.value.slice(0, index)));
  mirror.appendChild(marker);

  document.body.appendChild(mirror);
  const top = marker.offsetTop;
  mirror.remove();
  return top;
}

/** Belt and braces: strip any stray marks left in the rendered container. */
function clearStraySearchHighlights() {
  [dom.markdownContent(), dom.comparePaneHost()].forEach((container) => {
    if (!container) return;
    container.querySelectorAll("mark.viewer-search-match").forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(mark.textContent), mark);
      parent.normalize();
    });
  });
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
