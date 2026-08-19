/**
 * GooseQuill — Opening Documents in the Studio
 *
 * Loading a document, putting it on screen, and moving between the ones that
 * are already open.
 */

import { appState } from "../state.js";
import { parsePages, splitSequential } from "../services/page_splitter.js";
import { populateDocumentSelect, resolvePdfPath } from "../services/document_catalog.js";
import { switchStudioView } from "../components/header.js";
import { studio } from "./state.js";
import * as dom from "./dom.js";
import * as tabs from "./tabs.js";
import { renderPageList } from "./outline.js";
import { updateDisplay, updateSaveButtonState } from "./render.js";
import { updatePdfPageView, applyZoom, applyScanAvailability } from "./page_view.js";
import { updateToolbarAvailability } from "./availability.js";
import { goToPage } from "./navigation.js";
import { setDiffEnabled, clearDiffCache } from "./diff.js";

/** Open a document in the Studio, or go to it if it is already open. */
export async function openDocumentInStudio(doc, { startPage = 1 } = {}) {
  switchStudioView("studio");
  applyZoom();

  // Already open: go to it rather than loading a second copy.
  const existing = tabs.findTab(doc.path);
  if (existing !== -1) {
    await activateTab(existing, startPage > 1 ? startPage : null);
    return;
  }

  tabs.captureActivePosition();
  await activateTab(tabs.openTab(doc, startPage), startPage);
  updateStudioPresence();
}

export async function activateTab(index, startPage = null) {
  const tab = tabs.tabs[index];
  if (!tab) return;

  if (index !== tabs.activeIndex) tabs.captureActivePosition();
  tabs.setActiveIndex(index);

  setupDocState(tab.doc);
  applyScanAvailability();
  updateToolbarAvailability();
  renderTabStrip();
  tabs.updateNavTabLabel();
  updateStudioPresence();

  if (tab.content) {
    // Already loaded once; restore it rather than fetching again.
    appState.currentViewingMarkdownContent = tab.content;
    appState.currentViewingMarkdownPath = tab.markdownPath;
    studio.pagesMap = tab.pagesMap;
    studio.rawEditorDirty = false;
    renderPageList({ onSelect: (page) => goToPage(page, true) });
    updateDisplay();
    updateSaveButtonState();
  } else {
    await loadAndRender(tab.doc);
    tabs.recordLoaded();
  }

  // Always go, even to page 1: this is what refreshes the scan pane, and
  // skipping it left the previous tab's page on screen under the new tab's name.
  goToPage(startPage || tab.currentPage || 1, true);
  updatePdfPageView();

  clearDiffCache();
  if (studio.diffEnabled) setDiffEnabled(true);
}

export function closeTab(index) {
  const outcome = tabs.removeTab(index);
  if (!outcome.closed) return;

  if (outcome.empty) {
    renderTabStrip();
    updateStudioPresence();
    return;
  }

  if (outcome.activate !== null) {
    activateTab(outcome.activate);
    return;
  }
  renderTabStrip();
}

/** Move to the next or previous open document. */
export function stepTab(delta) {
  const index = tabs.neighbourIndex(delta);
  if (index !== -1) activateTab(index);
}

function renderTabStrip() {
  tabs.renderTabStrip({ onSelect: activateTab, onClose: closeTab });
}

/** Point the shared document state at a document, and re-label the chrome. */
function setupDocState(doc) {
  appState.currentViewingDoc = doc;
  // A consolidation is assembled from many filings; there is no single scan
  // behind it, and resolving one would point the scan pane at a file that does
  // not exist.
  appState.currentViewingPdfPath = doc.is_consolidated ? null : resolvePdfPath(doc);
  appState.currentViewingMarkdownPath = doc.output_path || doc.path;
  appState.currentPdfPage = 1;
  appState.totalPdfPages = doc.total_pages || 1;

  const meta = dom.docMeta();
  if (meta) {
    const size = `${((doc.file_size || 0) / 1024).toFixed(0)} KB`;
    meta.textContent = doc.is_consolidated
      ? `Consolidated • ${size} • ${doc.folder}`
      : `${doc.total_pages || 1} pages • ${size} • ${doc.folder}`;
  }

  // Pane A names itself through its picker, the same way pane B does.
  const select = dom.docSelect();
  if (select) {
    populateDocumentSelect(select, { placeholder: "Choose a document…" });
    select.value = doc.path;
  }
}

async function loadAndRender(doc) {
  const content = dom.markdownContent();
  if (content) {
    content.innerHTML = `<div class="text-muted text-center" style="padding: 60px;">Loading markdown transcription...</div>`;
  }

  updatePdfPageView();

  try {
    const res = await fetch(`/api/markdown?path=${encodeURIComponent(doc.path)}`);
    if (!res.ok) throw new Error("Could not load markdown");
    const data = await res.json();

    appState.currentViewingMarkdownContent = data.content;
    // The server resolves a PDF path to its Markdown/<stem>.md; keep the
    // resolved path so saving writes back to the file we actually read.
    if (data.path) appState.currentViewingMarkdownPath = data.path;

    if (doc.is_consolidated) {
      // Every source document in a consolidation starts again at page 1, so
      // keying by the page number written in the file would have each one
      // overwrite the last. Blocks are keyed by position and labelled with the
      // page they claim to be — the same split the Combiner preview uses.
      const { pages, labels } = splitSequential(data.content);
      studio.pagesMap = pages;
      studio.pageLabels = labels;
      appState.totalPdfPages = Object.keys(pages).filter((k) => /^\d+$/.test(k)).length || 1;
    } else {
      studio.pagesMap = parsePages(data.content);
      studio.pageLabels = null;
    }

    studio.rawEditorDirty = false;
    renderPageList({ onSelect: (page) => goToPage(page, true) });
    updateDisplay();
    updateSaveButtonState();

    clearDiffCache();
    if (studio.diffEnabled) setDiffEnabled(true);
  } catch (e) {
    if (content) {
      content.innerHTML = `<div class="text-danger text-center" style="padding: 40px;">Error loading markdown: ${e.message}</div>`;
    }
  }
}

/**
 * Show either the Studio proper or its empty state.
 *
 * Studio is a permanent destination now, so it can be reached with nothing
 * open — from the nav, or by closing the last tab and coming back.
 */
export function updateStudioPresence() {
  const empty = dom.byId("studioEmptyState");
  const workspace = dom.byId("studioWorkspaceContainer");
  const hasDocument = tabs.tabs.length > 0;

  if (empty) empty.style.display = hasDocument ? "none" : "flex";
  if (workspace) workspace.style.display = hasDocument ? "flex" : "none";

  const badge = dom.byId("topNavStudioDocBadge");
  if (badge) badge.style.display = hasDocument ? "inline-flex" : "none";
  const name = dom.byId("tabNavStudioDocName");
  if (name && !hasDocument) name.textContent = "Studio";
}

/** Redraw everything for the document already in state. */
export function renderStudioView() {
  updateStudioPresence();
  if (tabs.tabs.length === 0) return;
  renderPageList({ onSelect: (page) => goToPage(page, true) });
  updateDisplay();
  applyZoom();
}
