/**
 * GooseQuill — Transcript Rendering
 *
 * What the transcript pane shows: rendered or raw, whole document or one page,
 * and the virtualised view that draws it.
 */

import { appState } from "../state.js";
import { TranscriptView } from "../services/transcript_view.js";
import { studio, searchState } from "./state.js";
import * as dom from "./dom.js";
import { updatePdfPageView } from "./page_view.js";
import { updateActiveItem } from "./outline.js";
import { performSearch } from "./search.js";

/** The Markdown behind whatever is currently on screen. */
export function getActiveMarkdownText() {
  if (studio.scope === "page") {
    return studio.pagesMap[appState.currentPdfPage] || appState.currentViewingMarkdownContent || "";
  }
  return appState.currentViewingMarkdownContent || "";
}

/** Switch between the rendered transcript and the Markdown behind it. */
export function setFormat(format) {
  studio.format = format;
  const isRendered = format === "rendered";

  dom.formatRenderedBtn()?.classList.toggle("active", isRendered);
  dom.formatRawBtn()?.classList.toggle("active", !isRendered);

  const rendered = dom.markdownContent();
  const raw = dom.rawWrapper();
  if (rendered) rendered.style.display = isRendered ? "block" : "none";
  if (raw) raw.style.display = isRendered ? "none" : "flex";

  updateDisplay();
  updateSaveButtonState();

  // Matches belong to the surface they were found on; re-run against the new one.
  if (searchState.isOpen && searchState.query) {
    performSearch(searchState.query, searchState.matchCase);
  }
}

/** Switch between the whole document and the page on screen. */
export function setScope(scope) {
  studio.scope = scope;
  const isAll = scope === "all";

  dom.scopeAllBtn()?.classList.toggle("active", isAll);
  dom.scopePageBtn()?.classList.toggle("active", !isAll);

  updateDisplay();
  updateSaveButtonState();
}

/** Push the current page map into both the transcript and the raw editor. */
export function updateDisplay() {
  // The raw editor still holds plain text; only the rendered side is virtualised.
  const textarea = dom.rawTextarea();
  if (textarea) textarea.value = getActiveMarkdownText();

  ensureTranscript();
  if (studio.transcript) {
    studio.transcript.setDocument(studio.pagesMap, {
      restrictToPage: studio.scope === "page" ? appState.currentPdfPage : null,
      pageLabels: studio.pageLabels
    });
  }

  updateActiveItem();
}

/** Rebuild the rendered transcript from the current page map, scope intact. */
export function rerenderTranscript(options = {}) {
  ensureTranscript();
  if (studio.transcript) {
    studio.transcript.setDocument(studio.pagesMap, {
      restrictToPage: null,
      pageLabels: studio.pageLabels,
      ...options
    });
  }
}

/**
 * Create the transcript view once its panes exist.
 *
 * There is one of these now. While the modal viewer shared this code there were
 * two, and every lookup that was not scoped to one of them acted on whichever
 * happened to be live — the ambiguity behind more than one real bug.
 */
export function ensureTranscript() {
  if (studio.transcript) return;

  const pane = dom.markdownPane();
  const content = dom.markdownContent();
  if (!pane || !content) return;

  studio.transcript = new TranscriptView(pane, content, {
    onActivePageChange: (page) => {
      if (page === appState.currentPdfPage) return;
      if (page < 1 || page > appState.totalPdfPages) return;
      appState.currentPdfPage = page;
      updatePdfPageView();
      updateActiveItem();
    }
  });
}

/**
 * Show Save only where saving is meaningful, and only once something changed.
 *
 * Saving is refused in "Page Only" scope on purpose: the editor holds one page
 * there, and writing it back would replace the whole file with that page.
 */
export function updateSaveButtonState() {
  const btn = dom.saveBtn();
  if (!btn) return;

  const canSave = studio.format === "raw" && studio.scope === "all";
  btn.style.display = canSave ? "inline-flex" : "none";
  btn.disabled = !studio.rawEditorDirty;
  btn.classList.toggle("btn-primary", studio.rawEditorDirty);
  btn.classList.toggle("btn-secondary", !studio.rawEditorDirty);
  btn.title = studio.rawEditorDirty ? "Save edits to the .md file on disk" : "No unsaved changes";
}
