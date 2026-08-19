/**
 * GooseQuill — Document Studio
 *
 * Wiring only: every element the Studio owns, connected to the module that
 * knows what to do with it. The behaviour lives in the modules beside this one.
 *
 * This replaces `viewer_modal.js`, which was one 1,700-line file holding two
 * surfaces — a modal viewer and the Studio — with a copy of every pane in each
 * and a `getActiveContext()` deciding which copy a given lookup meant. The
 * modal was strictly the lesser of the two and its own toolbar offered a button
 * to leave it for the Studio, so it is gone; "View .md" opens the Studio now.
 */

import { appState, eventBus } from "../state.js";
import { showToast } from "../services/notifications.js";
import { findDocumentByPath } from "../services/document_catalog.js";
import { switchStudioView } from "../components/header.js";

import { studio } from "./state.js";
import * as dom from "./dom.js";
import { setFormat, setScope, getActiveMarkdownText } from "./render.js";
import { setZoom, toggleScanPane } from "./page_view.js";
import { stepPage } from "./navigation.js";
import { toggleSearchBar, closeSearchBar, toggleMatchCase, handleSearchInput, handleSearchKeydown, navigateMatch, setSearchPane } from "./search.js";
import { setDiffEnabled, setDiffMode, goToChangedPage } from "./diff.js";
import { toggleCompare, toggleLinkPages } from "./compare.js";
import { initEditor } from "./editor.js";
import { initStudioSplitters } from "./panes.js";
import { initStudioShortcuts } from "./shortcuts.js";
import { initDocumentSwitcher, openDocumentSwitcher } from "./switcher.js";
import { openDocumentInStudio, renderStudioView, updateStudioPresence } from "./document.js";
import { updateToolbarAvailability } from "./availability.js";

export function initStudio() {
  wireToolbar();
  wireFindBar();
  wireScanPane();
  wireCompareAndDiff();

  initEditor();
  initStudioSplitters();
  initDocumentSwitcher((doc) => openDocumentInStudio(doc));
  initStudioShortcuts();

  wireScrollSync();
  wireEvents();

  dom.byId("studioEmptyOpenBtn")?.addEventListener("click", openDocumentSwitcher);
  updateStudioPresence();
  updateToolbarAvailability();
}

function wireToolbar() {
  dom.formatRenderedBtn()?.addEventListener("click", () => setFormat("rendered"));
  dom.formatRawBtn()?.addEventListener("click", () => setFormat("raw"));
  dom.scopeAllBtn()?.addEventListener("click", () => setScope("all"));
  dom.scopePageBtn()?.addEventListener("click", () => setScope("page"));

  dom.byId("studioBackToWorkspaceBtn")?.addEventListener("click", () => switchStudioView("workspace"));

  dom.autoSyncBtn()?.addEventListener("click", (event) => {
    studio.autoSync = !studio.autoSync;
    const btn = event.currentTarget;
    btn.classList.toggle("active", studio.autoSync);
    btn.setAttribute("aria-pressed", String(studio.autoSync));
    btn.title = studio.autoSync
      ? "Keep the scan in step with the transcript as you scroll"
      : "The scan no longer follows the transcript";
  });

  dom.byId("studioCopyBtn")?.addEventListener("click", (event) => {
    const text = getActiveMarkdownText();
    if (!text) return;
    navigator.clipboard.writeText(text);
    const btn = event.currentTarget;
    const previous = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(() => (btn.textContent = previous), 2000);
    showToast("Copied", "Markdown is on your clipboard.");
  });

  dom.byId("studioDownloadBtn")?.addEventListener("click", () => {
    const text = getActiveMarkdownText();
    if (!text) return;
    const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = (appState.currentViewingDoc?.name || "document").replace(/\.pdf$/i, ".md");
    a.click();
    URL.revokeObjectURL(url);
  });

  // Pane A document picker — symmetric with pane B's.
  const select = dom.docSelect();
  select?.addEventListener("change", () => {
    const doc = findDocumentByPath(select.value);
    if (doc) openDocumentInStudio(doc);
  });
}

function wireFindBar() {
  dom.searchToggleBtn()?.addEventListener("click", toggleSearchBar);
  dom.byId("studioSearchCloseBtn")?.addEventListener("click", closeSearchBar);
  dom.searchCaseBtn()?.addEventListener("click", toggleMatchCase);
  dom.byId("studioSearchPrevBtn")?.addEventListener("click", () => navigateMatch(-1));
  dom.byId("studioSearchNextBtn")?.addEventListener("click", () => navigateMatch(1));

  dom.searchPaneButtons().forEach((btn) => {
    btn.addEventListener("click", () => setSearchPane(btn.dataset.pane));
  });

  const input = dom.searchInput();
  input?.addEventListener("input", (e) => handleSearchInput(e.target.value));
  input?.addEventListener("keydown", handleSearchKeydown);
}

function wireScanPane() {
  dom.togglePdfBtn()?.addEventListener("click", toggleScanPane);
  dom.pdfPrevBtn()?.addEventListener("click", (e) => {
    e.stopPropagation();
    stepPage(-1);
  });
  dom.pdfNextBtn()?.addEventListener("click", (e) => {
    e.stopPropagation();
    stepPage(1);
  });

  document.querySelectorAll(".pdf-zoom-controls [data-zoom]").forEach((btn) => {
    btn.addEventListener("click", () => setZoom(btn.dataset.zoom));
  });
}

function wireCompareAndDiff() {
  dom.compareBtn()?.addEventListener("click", toggleCompare);
  dom.linkPagesBtn()?.addEventListener("click", () => toggleLinkPages(appState.currentPdfPage));

  dom.diffBtn()?.addEventListener("click", () => setDiffEnabled(!studio.diffEnabled));
  dom.diffModeSelect()?.addEventListener("change", (e) => setDiffMode(e.target.value));
  dom.diffPrevBtn()?.addEventListener("click", () => goToChangedPage(-1));
  dom.diffNextBtn()?.addEventListener("click", () => goToChangedPage(1));
}

/** Scrolling the transcript moves the scan with it. */
function wireScrollSync() {
  const pane = dom.markdownPane();
  if (!pane) return;

  let ticking = false;
  pane.addEventListener(
    "scroll",
    () => {
      if (!studio.autoSync || studio.scope === "page" || ticking) return;
      ticking = true;
      window.requestAnimationFrame(() => {
        studio.transcript?.syncActivePageFromScroll();
        ticking = false;
      });
    },
    { passive: true }
  );
}

function wireEvents() {
  // "View .md" in the Workspace table. It used to open a modal that duplicated
  // every Studio surface and offered a button to leave itself for the Studio.
  eventBus.on("modal:viewer:open", (doc) => openDocumentInStudio(doc));

  eventBus.on("studio:document:open", (payload) => {
    const doc = payload?.doc ?? payload;
    const startPage = payload?.startPage ?? 1;
    if (doc) openDocumentInStudio(doc, { startPage });
  });

  eventBus.on("studio:document:activated", () => {
    if (appState.currentViewingDoc) renderStudioView();
  });
}
