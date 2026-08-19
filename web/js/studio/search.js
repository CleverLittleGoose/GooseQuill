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

function setCount(text) {
  const el = dom.searchCount();
  if (el) el.textContent = text;
}

function setNavEnabled(enabled) {
  dom.searchNavButtons().forEach((btn) => (btn.disabled = !enabled));
}

export function openSearchBar() {
  searchState.isOpen = true;

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

  if (studio.transcript) studio.transcript.clearSearch();
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

  if (studio.format === "raw") {
    performRawSearch(searchState.query, matchCase, dom.rawTextarea());
    return;
  }

  const view = studio.transcript;
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
  if (studio.format === "raw") {
    const count = searchState.rawMatches.length;
    if (count === 0) return;
    activateRawMatch((searchState.currentIndex + direction + count) % count);
    return;
  }

  const view = studio.transcript;
  if (!view || view.searchHits.length === 0) return;
  view.nextHit(direction);
  syncCountFromView(view);
}

/** Mirror the view's search position into the toolbar, and follow it with the scan. */
function syncCountFromView(view) {
  setCount(`${view.currentHitIndex + 1} of ${view.searchHits.length}`);

  const page = view.getCurrentHitPage();
  if (page && page !== appState.currentPdfPage && page >= 1 && page <= appState.totalPdfPages) {
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
  activateRawMatch(0);
}

function activateRawMatch(index) {
  const textarea = dom.rawTextarea();
  const match = searchState.rawMatches[index];
  if (!textarea || !match) return;

  searchState.currentIndex = index;
  setCount(`${index + 1} of ${searchState.rawMatches.length}`);

  // Focus first: an unfocused textarea shows no selection, so the match would
  // be scrolled to but invisible.
  textarea.focus();
  textarea.setSelectionRange(match.start, match.end);
  textarea.scrollTop = Math.max(0, measureTextareaOffsetTop(textarea, match.start) - textarea.clientHeight / 2);
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
  const container = dom.markdownContent();
  if (!container) return;
  container.querySelectorAll("mark.viewer-search-match").forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(mark.textContent), mark);
    parent.normalize();
  });
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
