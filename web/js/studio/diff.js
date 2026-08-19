/**
 * GooseQuill — Change Highlighting
 *
 * Reading one filing against another year of itself. Diff needs two documents,
 * so it is only offered once Compare is on and pane B actually holds something.
 */

import { appState } from "../state.js";
import { comparePageSets, diffPageHtml } from "../services/text_diff.js";
import { studio } from "./state.js";
import * as dom from "./dom.js";
import { goToPage } from "./navigation.js";

// Page pairs are diffed on demand and kept, so scrolling back over a page does
// not pay for the comparison twice. Keyed by page *and* mode, because the two
// modes give different answers for the same pair.
const diffCache = new Map();

/** Throw away every cached comparison — a document changed underneath them. */
export function clearDiffCache() {
  diffCache.clear();
}

/** Switch between comparing the Markdown and comparing the rendered words. */
export function setDiffMode(mode) {
  studio.diffMode = mode === "prose" ? "prose" : "source";
  updateDiffModeControl();
  clearDiffCache();
  if (studio.diffEnabled) setDiffEnabled(true);
}

function updateDiffModeControl() {
  const wrap = dom.diffModeWrap();
  const select = dom.diffModeSelect();
  if (wrap) wrap.style.display = studio.diffEnabled ? "inline-flex" : "none";
  if (select && select.value !== studio.diffMode) select.value = studio.diffMode;
}

/** Turn change highlighting on or off across both panes. */
export function setDiffEnabled(enabled) {
  const { comparePane } = studio;
  const canDiff = studio.compareEnabled && comparePane && comparePane.doc;

  studio.diffEnabled = enabled && canDiff;
  clearDiffCache();

  const diffBtn = dom.diffBtn();
  if (diffBtn) {
    diffBtn.classList.toggle("active", studio.diffEnabled);
    diffBtn.setAttribute("aria-pressed", String(studio.diffEnabled));
  }
  [dom.diffSummary(), dom.diffPrevBtn(), dom.diffNextBtn()].forEach((el) => {
    if (el) el.style.display = studio.diffEnabled ? "inline-flex" : "none";
  });
  updateDiffModeControl();

  if (!studio.diffEnabled) {
    studio.diffChangedPages = [];
    // Back to plain transcripts on both sides.
    if (studio.transcript) studio.transcript.setDocument(studio.pagesMap, { restrictToPage: null });
    if (comparePane && comparePane.doc) {
      comparePane.transcript.setDocument(comparePane.pagesMap, { restrictToPage: null });
      comparePane.setView("transcript");
    }
    const summary = dom.diffSummary();
    if (summary) summary.textContent = "";
    return;
  }

  const pagesB = comparePane.pagesMap;
  const comparison = comparePageSets(studio.pagesMap, pagesB, { mode: studio.diffMode });
  studio.diffChangedPages = comparison.changedPages;

  const summary = dom.diffSummary();
  if (summary) {
    const parts = [`${studio.diffChangedPages.length}/${comparison.sharedPages.length} changed`];
    if (comparison.onlyInA.length) parts.push(`${comparison.onlyInA.length} only A`);
    if (comparison.onlyInB.length) parts.push(`${comparison.onlyInB.length} only B`);
    summary.textContent = parts.join(" · ");
    summary.title = `${studio.diffChangedPages.length} of ${comparison.sharedPages.length} shared pages differ`;
  }

  // Both panes render the same page pair, each showing its own side.
  comparePane.setView("transcript");
  if (studio.transcript) {
    studio.transcript.setDocument(studio.pagesMap, {
      restrictToPage: null,
      renderPage: (page) => diffFor(page).aHtml
    });
  }
  comparePane.transcript.setDocument(pagesB, {
    restrictToPage: null,
    renderPage: (page) => diffFor(page).bHtml
  });

  updateDiffNavButtons();
}

/** Diff one page pair, remembering the result. */
function diffFor(page) {
  const key = `${studio.diffMode}:${page}`;
  if (diffCache.has(key)) return diffCache.get(key);

  const a = studio.pagesMap[page];
  const b = studio.comparePane ? studio.comparePane.pagesMap[page] : undefined;

  let result;
  if (a === undefined || b === undefined) {
    // A page with no counterpart is not a change to show word by word; say so.
    const side = a === undefined ? "B" : "A";
    const notice = `<div class="diff-body diff-missing">This page exists only in ${side}.</div>`;
    const content = escapeDiffText(a !== undefined ? a : b);
    result = {
      aHtml: a !== undefined ? `<div class="diff-body">${content}</div>` : notice,
      bHtml: b !== undefined ? `<div class="diff-body">${content}</div>` : notice,
      changed: true
    };
  } else {
    result = diffPageHtml(a, b, { mode: studio.diffMode });
  }

  diffCache.set(key, result);
  return result;
}

function escapeDiffText(text) {
  return String(text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Jump both panes to the next or previous page that actually changed. */
export function goToChangedPage(direction) {
  if (!studio.diffEnabled || studio.diffChangedPages.length === 0) return;

  const pages = studio.diffChangedPages;
  const current = appState.currentPdfPage;

  let target;
  if (direction > 0) {
    target = pages.find((p) => p > current);
    if (target === undefined) target = pages[0];
  } else {
    const earlier = pages.filter((p) => p < current);
    target = earlier.length ? earlier[earlier.length - 1] : pages[pages.length - 1];
  }

  goToPage(target, true);
  updateDiffNavButtons();
}

function updateDiffNavButtons() {
  const hasChanges = studio.diffEnabled && studio.diffChangedPages.length > 0;
  [dom.diffPrevBtn(), dom.diffNextBtn()].forEach((btn) => {
    if (btn) btn.disabled = !hasChanges;
  });
}

/** Diff is only meaningful with a document in each pane. */
export function updateDiffAvailability() {
  const btn = dom.diffBtn();
  if (!btn) return;

  const canDiff = studio.compareEnabled && studio.comparePane && studio.comparePane.doc;
  btn.style.display = studio.compareEnabled ? "inline-flex" : "none";
  btn.disabled = !canDiff;
  btn.title = canDiff
    ? "Highlight what changed between the two documents"
    : "Choose a document in pane B first";

  if (!canDiff && studio.diffEnabled) setDiffEnabled(false);
  updateDiffModeControl();
}
