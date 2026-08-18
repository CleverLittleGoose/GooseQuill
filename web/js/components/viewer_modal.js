/**
 * GooseQuill - Document Viewer & Document Studio Workspace Component
 * Dual Paradigm: Lightweight Modal Viewer + Fullscreen Document Studio
 * Features: Rendered/Raw Markdown, Scope Toggle, Auto-Sync Scrolling, In-Viewer Search
 */

import { appState, eventBus } from "../state.js";
import { showToast } from "../services/notifications.js";
import { TranscriptView } from "../services/transcript_view.js";
import { switchStudioView } from "./header.js";

let autoSyncEnabled = true;
let isProgrammaticScroll = false;
let scrollTimeout = null;
let rawEditorDirty = false;
// Where we last parked a pane ourselves. Scroll events that report this exact
// position are the echo of our own move (or a relayout settling), not the user
// scrolling, and must not drive page detection.
let lastProgrammaticScrollTop = null;

// One virtualised transcript per surface. The modal and the Studio each own
// their panes, so they each own a view.
const transcripts = { viewer: null, studio: null };

/** The TranscriptView belonging to whichever surface is live. */
function getActiveTranscript() {
  return getActiveContext().isModal ? transcripts.viewer : transcripts.studio;
}

// Viewer & Studio State
let viewerFormat = "rendered"; // "rendered" | "raw"
let viewerScope = "all";       // "all" | "page"
let pagesMap = {};             // { 1: "...", 2: "..." }

// Search State
const searchState = {
  isOpen: false,
  query: "",
  matchCase: false,
  rawMatches: [],     // {start, end} offsets, raw editor mode
  currentIndex: -1,
  debounceTimer: null
};

export function initViewerModal() {
  // Modal Elements
  const viewerModal = document.getElementById("viewerModal");
  const closeViewerBtn = document.getElementById("closeViewerBtn");
  const viewerTogglePdfBtn = document.getElementById("viewerTogglePdfBtn");
  const viewerAutoScrollBtn = document.getElementById("viewerAutoScrollBtn");
  const viewerSearchToggleBtn = document.getElementById("viewerSearchToggleBtn");
  const viewerExpandStudioBtn = document.getElementById("viewerExpandStudioBtn");
  const viewerCopyBtn = document.getElementById("viewerCopyBtn");
  const viewerDownloadBtn = document.getElementById("viewerDownloadBtn");
  const pdfPrevPageBtn = document.getElementById("pdfPrevPageBtn");
  const pdfNextPageBtn = document.getElementById("pdfNextPageBtn");
  const viewerPdfPane = document.getElementById("viewerPdfPane");
  const viewerMarkdownPane = document.getElementById("viewerMarkdownPane");

  // Modal Format / Scope Toggles
  const viewerFormatRenderedBtn = document.getElementById("viewerFormatRenderedBtn");
  const viewerFormatRawBtn = document.getElementById("viewerFormatRawBtn");
  const viewerScopeAllBtn = document.getElementById("viewerScopeAllBtn");
  const viewerScopePageBtn = document.getElementById("viewerScopePageBtn");

  // Studio Elements
  const studioBackToWorkspaceBtn = document.getElementById("studioBackToWorkspaceBtn");
  const studioFormatRenderedBtn = document.getElementById("studioFormatRenderedBtn");
  const studioFormatRawBtn = document.getElementById("studioFormatRawBtn");
  const studioScopeAllBtn = document.getElementById("studioScopeAllBtn");
  const studioScopePageBtn = document.getElementById("studioScopePageBtn");
  const studioAutoScrollBtn = document.getElementById("studioAutoScrollBtn");
  const studioSearchToggleBtn = document.getElementById("studioSearchToggleBtn");
  const studioTogglePdfBtn = document.getElementById("studioTogglePdfBtn");
  const studioCopyBtn = document.getElementById("studioCopyBtn");
  const studioDownloadBtn = document.getElementById("studioDownloadBtn");
  const studioPdfPrevPageBtn = document.getElementById("studioPdfPrevPageBtn");
  const studioPdfNextPageBtn = document.getElementById("studioPdfNextPageBtn");
  const studioPdfPane = document.getElementById("studioPdfPane");
  const studioMarkdownPane = document.getElementById("studioMarkdownPane");

  // Search UI Elements
  const viewerSearchBar = document.getElementById("viewerSearchBar");
  const viewerSearchInput = document.getElementById("viewerSearchInput");
  const viewerSearchCaseBtn = document.getElementById("viewerSearchCaseBtn");
  const viewerSearchPrevBtn = document.getElementById("viewerSearchPrevBtn");
  const viewerSearchNextBtn = document.getElementById("viewerSearchNextBtn");
  const viewerSearchCloseBtn = document.getElementById("viewerSearchCloseBtn");

  const studioSearchBar = document.getElementById("studioSearchBar");
  const studioSearchInput = document.getElementById("studioSearchInput");
  const studioSearchCaseBtn = document.getElementById("studioSearchCaseBtn");
  const studioSearchPrevBtn = document.getElementById("studioSearchPrevBtn");
  const studioSearchNextBtn = document.getElementById("studioSearchNextBtn");
  const studioSearchCloseBtn = document.getElementById("studioSearchCloseBtn");

  // Close Modal
  if (closeViewerBtn) {
    closeViewerBtn.addEventListener("click", () => {
      closeSearchBar();
      if (viewerModal) viewerModal.style.display = "none";
    });
  }

  // Expand to Fullscreen Document Studio
  if (viewerExpandStudioBtn) {
    viewerExpandStudioBtn.addEventListener("click", () => {
      closeSearchBar();
      if (viewerModal) viewerModal.style.display = "none";
      if (appState.currentViewingDoc) {
        openDocumentInStudio(appState.currentViewingDoc);
      }
    });
  }

  // Studio Back Button
  if (studioBackToWorkspaceBtn) {
    studioBackToWorkspaceBtn.addEventListener("click", () => {
      switchStudioView("workspace");
    });
  }

  // Format Toggles (Rendered vs Raw)
  if (viewerFormatRenderedBtn) viewerFormatRenderedBtn.addEventListener("click", () => setViewerFormat("rendered"));
  if (viewerFormatRawBtn) viewerFormatRawBtn.addEventListener("click", () => setViewerFormat("raw"));
  if (studioFormatRenderedBtn) studioFormatRenderedBtn.addEventListener("click", () => setViewerFormat("rendered"));
  if (studioFormatRawBtn) studioFormatRawBtn.addEventListener("click", () => setViewerFormat("raw"));

  // Scope Toggles (All vs Current Page)
  if (viewerScopeAllBtn) viewerScopeAllBtn.addEventListener("click", () => setViewerScope("all"));
  if (viewerScopePageBtn) viewerScopePageBtn.addEventListener("click", () => setViewerScope("page"));
  if (studioScopeAllBtn) studioScopeAllBtn.addEventListener("click", () => setViewerScope("all"));
  if (studioScopePageBtn) studioScopePageBtn.addEventListener("click", () => setViewerScope("page"));

  // Toggle Auto-Sync
  const toggleAutoSync = () => {
    autoSyncEnabled = !autoSyncEnabled;
    [viewerAutoScrollBtn, studioAutoScrollBtn].forEach((btn) => {
      if (btn) {
        btn.classList.toggle("active", autoSyncEnabled);
        btn.textContent = autoSyncEnabled ? "⚡ Auto-Sync" : "⚡ Auto-Sync (Off)";
      }
    });
  };
  if (viewerAutoScrollBtn) viewerAutoScrollBtn.addEventListener("click", toggleAutoSync);
  if (studioAutoScrollBtn) studioAutoScrollBtn.addEventListener("click", toggleAutoSync);

  // Search Bar Toggle & Controls (Modal)
  if (viewerSearchToggleBtn) {
    viewerSearchToggleBtn.addEventListener("click", () => {
      searchState.isOpen ? closeSearchBar() : openSearchBar();
    });
  }
  if (viewerSearchCloseBtn) viewerSearchCloseBtn.addEventListener("click", () => closeSearchBar());
  if (viewerSearchCaseBtn) {
    viewerSearchCaseBtn.addEventListener("click", () => toggleSearchCase(viewerSearchCaseBtn, viewerSearchInput));
  }
  if (viewerSearchNextBtn) viewerSearchNextBtn.addEventListener("click", () => navigateMatch(1));
  if (viewerSearchPrevBtn) viewerSearchPrevBtn.addEventListener("click", () => navigateMatch(-1));
  if (viewerSearchInput) {
    viewerSearchInput.addEventListener("input", (e) => handleSearchInput(e.target.value));
    viewerSearchInput.addEventListener("keydown", (e) => handleSearchKeydown(e));
  }

  // Search Bar Toggle & Controls (Studio)
  if (studioSearchToggleBtn) {
    studioSearchToggleBtn.addEventListener("click", () => {
      searchState.isOpen ? closeSearchBar() : openSearchBar();
    });
  }
  if (studioSearchCloseBtn) studioSearchCloseBtn.addEventListener("click", () => closeSearchBar());
  if (studioSearchCaseBtn) {
    studioSearchCaseBtn.addEventListener("click", () => toggleSearchCase(studioSearchCaseBtn, studioSearchInput));
  }
  if (studioSearchNextBtn) studioSearchNextBtn.addEventListener("click", () => navigateMatch(1));
  if (studioSearchPrevBtn) studioSearchPrevBtn.addEventListener("click", () => navigateMatch(-1));
  if (studioSearchInput) {
    studioSearchInput.addEventListener("input", (e) => handleSearchInput(e.target.value));
    studioSearchInput.addEventListener("keydown", (e) => handleSearchKeydown(e));
  }

  // Toggle PDF Split Panes
  if (viewerTogglePdfBtn) {
    viewerTogglePdfBtn.addEventListener("click", () => {
      if (!viewerPdfPane) return;
      const isVisible = viewerPdfPane.style.display !== "none";
      viewerPdfPane.style.display = isVisible ? "none" : "flex";
      viewerTogglePdfBtn.textContent = isVisible ? "Show PDF Split" : "Hide PDF Split";
      if (!isVisible) updatePdfPageView();
    });
  }
  if (studioTogglePdfBtn) {
    studioTogglePdfBtn.addEventListener("click", () => {
      if (!studioPdfPane) return;
      const isVisible = studioPdfPane.style.display !== "none";
      studioPdfPane.style.display = isVisible ? "none" : "flex";
      studioTogglePdfBtn.textContent = isVisible ? "Show PDF Split" : "Hide PDF Split";
      if (!isVisible) updatePdfPageView();
    });
  }

  // PDF Page Navigation Controls
  const goPrev = (e) => {
    e.stopPropagation();
    goToPage(appState.currentPdfPage - 1, true);
  };
  const goNext = (e) => {
    e.stopPropagation();
    goToPage(appState.currentPdfPage + 1, true);
  };

  if (pdfPrevPageBtn) pdfPrevPageBtn.addEventListener("click", goPrev);
  if (pdfNextPageBtn) pdfNextPageBtn.addEventListener("click", goNext);
  if (studioPdfPrevPageBtn) studioPdfPrevPageBtn.addEventListener("click", goPrev);
  if (studioPdfNextPageBtn) studioPdfNextPageBtn.addEventListener("click", goNext);

  // Copy / Download Actions
  const handleCopy = (btn) => {
    const textToCopy = getActiveMarkdownText();
    if (textToCopy) {
      navigator.clipboard.writeText(textToCopy);
      const prevText = btn.textContent;
      btn.textContent = "Copied!";
      setTimeout(() => (btn.textContent = prevText), 2000);
      showToast("Copied", "Markdown is on your clipboard.");
    }
  };
  if (viewerCopyBtn) viewerCopyBtn.addEventListener("click", () => handleCopy(viewerCopyBtn));
  if (studioCopyBtn) studioCopyBtn.addEventListener("click", () => handleCopy(studioCopyBtn));

  const handleDownload = () => {
    const textToDownload = getActiveMarkdownText();
    if (!textToDownload) return;
    const title = (appState.currentViewingDoc?.name || "document").replace(/\.pdf$/i, ".md");
    const blob = new Blob([textToDownload], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = title;
    a.click();
    URL.revokeObjectURL(url);
  };
  if (viewerDownloadBtn) viewerDownloadBtn.addEventListener("click", handleDownload);
  if (studioDownloadBtn) studioDownloadBtn.addEventListener("click", handleDownload);

  // Raw editor persistence
  const viewerSaveBtn = document.getElementById("viewerSaveBtn");
  const studioSaveBtn = document.getElementById("studioSaveBtn");
  if (viewerSaveBtn) viewerSaveBtn.addEventListener("click", saveRawMarkdown);
  if (studioSaveBtn) studioSaveBtn.addEventListener("click", saveRawMarkdown);

  ["viewerRawMarkdownTextarea", "studioRawMarkdownTextarea"].forEach((id) => {
    const ta = document.getElementById(id);
    if (!ta) return;
    ta.addEventListener("input", markRawEditorDirty);
    ta.addEventListener("keydown", (e) => {
      // Cmd/Ctrl+S saves from inside the editor.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveRawMarkdown();
        return;
      }
      // With the find bar open, Enter walks matches instead of breaking the line.
      if (searchState.isOpen && searchState.rawMatches.length > 0 && e.key === "Enter") {
        e.preventDefault();
        navigateMatch(e.shiftKey ? -1 : 1);
      }
    });
  });

  // Keyboard navigation
  window.addEventListener("keydown", (e) => {
    const isModalOpen = viewerModal && viewerModal.style.display === "flex";
    const isStudioOpen = appState.currentView === "studio";

    if (isModalOpen || isStudioOpen) {
      // Cmd+F / Ctrl+F -> Search
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        openSearchBar();
        return;
      }

      if (e.key === "Escape") {
        if (searchState.isOpen) {
          e.preventDefault();
          closeSearchBar();
        } else if (isModalOpen) {
          viewerModal.style.display = "none";
        }
        return;
      }

      // Page keys must never fire while the caret is in a field. Guarding only
      // the two search inputs meant arrow keys in the raw editor flipped the
      // PDF instead of moving the cursor, so the transcript could not be edited.
      if (isTextEntryElement(document.activeElement)) return;

      if (e.key === "ArrowLeft" || e.key === "PageUp") {
        goToPage(appState.currentPdfPage - 1, true);
      } else if (e.key === "ArrowRight" || e.key === "PageDown") {
        goToPage(appState.currentPdfPage + 1, true);
      }
    }
  });

  // Scroll Sync (Modal)
  if (viewerMarkdownPane) {
    let isTicking = false;
    viewerMarkdownPane.addEventListener(
      "scroll",
      (event) => {
        if (!autoSyncEnabled || isProgrammaticScroll || viewerScope === "page") return;
        if (isEchoOfProgrammaticScroll(event.currentTarget)) return;
        if (!isTicking) {
          window.requestAnimationFrame(() => {
            if (transcripts.viewer) transcripts.viewer.syncActivePageFromScroll();
            isTicking = false;
          });
          isTicking = true;
        }
      },
      { passive: true }
    );
  }

  // Scroll Sync (Studio)
  if (studioMarkdownPane) {
    let isTicking = false;
    studioMarkdownPane.addEventListener(
      "scroll",
      (event) => {
        if (!autoSyncEnabled || isProgrammaticScroll || viewerScope === "page") return;
        if (isEchoOfProgrammaticScroll(event.currentTarget)) return;
        if (!isTicking) {
          window.requestAnimationFrame(() => {
            if (transcripts.studio) transcripts.studio.syncActivePageFromScroll();
            isTicking = false;
          });
          isTicking = true;
        }
      },
      { passive: true }
    );
  }

  eventBus.on("modal:viewer:open", (doc) => openDocumentViewer(doc));
  eventBus.on("studio:document:open", (doc) => openDocumentInStudio(doc));
  eventBus.on("studio:document:activated", () => {
    if (appState.currentViewingDoc) {
      renderStudioView();
    }
  });
}

/**
 * Which surface is live right now.
 *
 * The modal and the Studio hold two independent copies of every pane, so any
 * lookup that is not scoped to one of them silently acts on the other. This is
 * the single place that decides which copy is in play.
 */
function getActiveContext() {
  const viewerModal = document.getElementById("viewerModal");
  const isModalOpen = viewerModal && viewerModal.style.display === "flex";
  const prefix = isModalOpen ? "viewer" : "studio";

  return {
    isModal: isModalOpen,
    pane: document.getElementById(isModalOpen ? "viewerMarkdownPane" : "studioMarkdownPane"),
    content: document.getElementById(`${prefix}MarkdownContent`),
    textarea: document.getElementById(`${prefix}RawMarkdownTextarea`),
  };
}

/** True when focus is somewhere the user is typing. */
function isTextEntryElement(el) {
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable === true;
}

// How long the sync listener stays muted after we move a pane ourselves, so it
// cannot mistake our own scroll for the user's and start a feedback loop.
const PROGRAMMATIC_SCROLL_SETTLE_MS = 120;

/**
 * True when this scroll event is our own move echoing back.
 *
 * The timer alone is not enough: a 600,000px transcript keeps settling as
 * lazy images resolve, and a late scroll event arriving after the mute expired
 * used to snap the PDF to the last page while the markdown sat on page 10.
 */
function isEchoOfProgrammaticScroll(pane) {
  if (lastProgrammaticScrollTop === null) return false;
  if (Math.abs(pane.scrollTop - lastProgrammaticScrollTop) <= 4) return true;
  lastProgrammaticScrollTop = null;
  return false;
}

/**
 * Splits raw consolidated markdown document into page-indexed string chunks
 */
function parseMarkdownPages(fullMarkdown) {
  const pages = {};
  if (!fullMarkdown) return pages;

  const pattern = /(?:<!--\s*Page\s+(\d+)\s*-->|(?:\n|^)##\s+Page\s+(\d+))/gi;
  const splits = [];
  let match;

  while ((match = pattern.exec(fullMarkdown)) !== null) {
    splits.push({
      pageNum: parseInt(match[1] || match[2], 10),
      start: match.index,
      headerEnd: pattern.lastIndex
    });
  }

  if (splits.length === 0) {
    pages[1] = fullMarkdown.trim();
    return pages;
  }

  // Everything before the first page marker is the document header the
  // converter writes (title, source file, model). Splitting on markers alone
  // dropped it, so it is carried separately rather than lost.
  const preamble = fullMarkdown.slice(0, splits[0].start).trim();
  if (preamble) pages.preamble = preamble;

  for (let i = 0; i < splits.length; i++) {
    const current = splits[i];
    const nextStart = i + 1 < splits.length ? splits[i + 1].start : fullMarkdown.length;
    let pageContent = fullMarkdown.substring(current.start, nextStart).trim();
    if (pageContent.endsWith("---")) {
      pageContent = pageContent.slice(0, -3).trim();
    }
    pages[current.pageNum] = pageContent;
  }

  return pages;
}

/**
 * Get active markdown text depending on current scope
 */
function getActiveMarkdownText() {
  if (viewerScope === "page") {
    return pagesMap[appState.currentPdfPage] || appState.currentViewingMarkdownContent || "";
  }
  return appState.currentViewingMarkdownContent || "";
}

/**
 * Switch Rendered vs Raw view mode
 */
export function setViewerFormat(format) {
  viewerFormat = format;

  // Update button active classes
  const isRendered = format === "rendered";
  document.querySelectorAll("#viewerFormatRenderedBtn, #studioFormatRenderedBtn").forEach((b) => b.classList.toggle("active", isRendered));
  document.querySelectorAll("#viewerFormatRawBtn, #studioFormatRawBtn").forEach((b) => b.classList.toggle("active", !isRendered));

  // Toggle container elements
  const viewerRendered = document.getElementById("viewerMarkdownContent");
  const viewerRaw = document.getElementById("viewerRawMarkdownWrapper");
  const studioRendered = document.getElementById("studioMarkdownContent");
  const studioRaw = document.getElementById("studioRawMarkdownWrapper");

  if (viewerRendered) viewerRendered.style.display = isRendered ? "block" : "none";
  if (viewerRaw) viewerRaw.style.display = isRendered ? "none" : "flex";
  if (studioRendered) studioRendered.style.display = isRendered ? "block" : "none";
  if (studioRaw) studioRaw.style.display = isRendered ? "none" : "flex";

  updateViewerDisplay();
  updateSaveButtonState();

  // Matches belong to the surface they were found on; re-run against the new one.
  if (searchState.isOpen && searchState.query) {
    performSearch(searchState.query, searchState.matchCase);
  }
}

/**
 * Switch Scope (Full Doc vs Current Page Only)
 */
export function setViewerScope(scope) {
  viewerScope = scope;

  const isAll = scope === "all";
  document.querySelectorAll("#viewerScopeAllBtn, #studioScopeAllBtn").forEach((b) => b.classList.toggle("active", isAll));
  document.querySelectorAll("#viewerScopePageBtn, #studioScopePageBtn").forEach((b) => b.classList.toggle("active", !isAll));

  updateViewerDisplay();
  updateSaveButtonState();
}

/**
 * Update Markdown panes with current format and scope
 */
function updateViewerDisplay() {
  const rawText = getActiveMarkdownText();

  // The raw editor still holds plain text; only the rendered side is virtualised.
  const viewerRawTextarea = document.getElementById("viewerRawMarkdownTextarea");
  const studioRawTextarea = document.getElementById("studioRawMarkdownTextarea");
  if (viewerRawTextarea) viewerRawTextarea.value = rawText;
  if (studioRawTextarea) studioRawTextarea.value = rawText;

  const restrictToPage = viewerScope === "page" ? appState.currentPdfPage : null;
  ensureTranscriptViews();

  [transcripts.viewer, transcripts.studio].forEach((view) => {
    if (view) view.setDocument(pagesMap, { restrictToPage });
  });

  updateStudioOutlineActiveItem();
}

/**
 * Create the per-surface transcript views once the panes exist.
 */
function ensureTranscriptViews() {
  const defs = [
    ["viewer", "viewerMarkdownPane", "viewerMarkdownContent"],
    ["studio", "studioMarkdownPane", "studioMarkdownContent"]
  ];

  defs.forEach(([key, paneId, contentId]) => {
    if (transcripts[key]) return;
    const pane = document.getElementById(paneId);
    const content = document.getElementById(contentId);
    if (!pane || !content) return;

    transcripts[key] = new TranscriptView(pane, content, {
      onActivePageChange: (page) => {
        // Only the live surface may drive the shared page state.
        if (getActiveTranscript() !== transcripts[key]) return;
        if (page === appState.currentPdfPage) return;
        if (page < 1 || page > appState.totalPdfPages) return;
        appState.currentPdfPage = page;
        updatePdfPageView();
        updateStudioOutlineActiveItem();
      }
    });
  });
}

/**
 * Render Studio Page Jump List Outline
 */
function renderStudioPageList() {
  const pageListContainer = document.getElementById("studioPageList");
  const studioPageCount = document.getElementById("studioPageCount");
  if (!pageListContainer) return;

  pageListContainer.innerHTML = "";
  const total = appState.totalPdfPages || 1;
  if (studioPageCount) studioPageCount.textContent = total;

  for (let p = 1; p <= total; p++) {
    const item = document.createElement("div");
    item.className = `studio-page-item ${p === appState.currentPdfPage ? "active" : ""}`;
    item.dataset.page = p;
    item.innerHTML = `<span>Page ${p}</span><span class="text-xs text-muted">${pagesMap[p] ? "✓" : "•"}</span>`;
    item.addEventListener("click", () => {
      goToPage(p, true);
    });
    pageListContainer.appendChild(item);
  }
}

function updateStudioOutlineActiveItem() {
  const items = document.querySelectorAll(".studio-page-item");
  items.forEach((item) => {
    const p = parseInt(item.dataset.page, 10);
    const isActive = p === appState.currentPdfPage;
    item.classList.toggle("active", isActive);
    if (isActive && item.scrollIntoViewIfNeeded) {
      item.scrollIntoViewIfNeeded();
    }
  });
}

/**
 * Open document in full Document Studio Workspace
 */
export async function openDocumentInStudio(doc) {
  setupDocState(doc);

  // Show Document Studio nav tab
  const tabNavStudio = document.getElementById("tabNavStudio");
  const tabNavStudioDocName = document.getElementById("tabNavStudioDocName");
  if (tabNavStudio) tabNavStudio.style.display = "inline-flex";
  if (tabNavStudioDocName) tabNavStudioDocName.textContent = doc.name;

  switchStudioView("studio");
  await loadAndRenderDoc(doc);
}

/**
 * Open document in lightweight modal dialog
 */
export async function openDocumentViewer(doc) {
  setupDocState(doc);

  const viewerModal = document.getElementById("viewerModal");
  if (viewerModal) viewerModal.style.display = "flex";

  await loadAndRenderDoc(doc);
}

function setupDocState(doc) {
  let pdfPath = doc.path;
  if (pdfPath && pdfPath.toLowerCase().endsWith(".md")) {
    pdfPath = pdfPath.replace(/[/\\]Markdown[/\\]/, "/").replace(/\.md$/i, ".pdf");
  }

  appState.currentViewingDoc = doc;
  appState.currentViewingPdfPath = pdfPath;
  appState.currentViewingMarkdownPath = doc.output_path || doc.path;
  appState.currentPdfPage = 1;
  appState.totalPdfPages = doc.total_pages || 1;

  // Update Header titles
  const metaText = `${doc.total_pages || 1} pages • ${(doc.file_size / 1024).toFixed(0)} KB • ${doc.folder}`;
  const vTitle = document.getElementById("viewerDocTitle");
  const vMeta = document.getElementById("viewerDocMeta");
  const sTitle = document.getElementById("studioDocTitle");
  const sMeta = document.getElementById("studioDocMeta");

  if (vTitle) vTitle.textContent = doc.name;
  if (vMeta) vMeta.textContent = metaText;
  if (sTitle) sTitle.textContent = doc.name;
  if (sMeta) sMeta.textContent = metaText;
}

async function loadAndRenderDoc(doc) {
  const viewerMarkdownContent = document.getElementById("viewerMarkdownContent");
  const studioMarkdownContent = document.getElementById("studioMarkdownContent");

  [viewerMarkdownContent, studioMarkdownContent].forEach((el) => {
    if (el) el.innerHTML = `<div class="text-muted text-center" style="padding: 60px;">Loading markdown transcription...</div>`;
  });

  updatePdfPageView();

  try {
    const res = await fetch(`/api/markdown?path=${encodeURIComponent(doc.path)}`);
    if (!res.ok) throw new Error("Could not load markdown");
    const data = await res.json();

    appState.currentViewingMarkdownContent = data.content;
    // The server resolves a PDF path to its Markdown/<stem>.md; keep the
    // resolved path so saving writes back to the file we actually read.
    if (data.path) appState.currentViewingMarkdownPath = data.path;
    pagesMap = parseMarkdownPages(data.content);

    rawEditorDirty = false;
    renderStudioPageList();
    updateViewerDisplay();
    updateSaveButtonState();
  } catch (e) {
    const errHtml = `<div class="text-danger text-center" style="padding: 40px;">Error loading markdown: ${e.message}</div>`;
    if (viewerMarkdownContent) viewerMarkdownContent.innerHTML = errHtml;
    if (studioMarkdownContent) studioMarkdownContent.innerHTML = errHtml;
  }
}

function renderStudioView() {
  renderStudioPageList();
  updateViewerDisplay();
  updatePdfPageView();
}

/**
 * Navigate to a specific PDF page, update preview canvas, and update / scroll markdown
 */
export function goToPage(pageNumber, scrollToMarkdown = true) {
  if (pageNumber < 1 || pageNumber > appState.totalPdfPages) return;
  appState.currentPdfPage = pageNumber;
  updatePdfPageView();
  updateStudioOutlineActiveItem();

  if (viewerScope === "page") {
    updateViewerDisplay();
  } else if (scrollToMarkdown && autoSyncEnabled) {
    const view = getActiveTranscript();
    if (view) view.scrollToPage(pageNumber);
  }
}

/**
 * Update PDF preview canvas image across Modal and Studio
 */
export function updatePdfPageView() {
  if (!appState.currentViewingPdfPath) return;

  const pageStr = `Page ${appState.currentPdfPage} of ${appState.totalPdfPages}`;
  const imgUrl = `/api/page_image?path=${encodeURIComponent(appState.currentViewingPdfPath)}&page=${appState.currentPdfPage}`;
  const isFirst = appState.currentPdfPage <= 1;
  const isLast = appState.currentPdfPage >= appState.totalPdfPages;

  // Modal
  const pdfPageIndicator = document.getElementById("pdfPageIndicator");
  const pdfPageImage = document.getElementById("pdfPageImage");
  const pdfPrevPageBtn = document.getElementById("pdfPrevPageBtn");
  const pdfNextPageBtn = document.getElementById("pdfNextPageBtn");

  if (pdfPageIndicator) pdfPageIndicator.textContent = pageStr;
  if (pdfPrevPageBtn) pdfPrevPageBtn.disabled = isFirst;
  if (pdfNextPageBtn) pdfNextPageBtn.disabled = isLast;
  if (pdfPageImage) pdfPageImage.src = imgUrl;

  // Studio
  const studioPdfPageIndicator = document.getElementById("studioPdfPageIndicator");
  const studioPdfPageImage = document.getElementById("studioPdfPageImage");
  const studioPdfPrevPageBtn = document.getElementById("studioPdfPrevPageBtn");
  const studioPdfNextPageBtn = document.getElementById("studioPdfNextPageBtn");

  if (studioPdfPageIndicator) studioPdfPageIndicator.textContent = pageStr;
  if (studioPdfPrevPageBtn) studioPdfPrevPageBtn.disabled = isFirst;
  if (studioPdfNextPageBtn) studioPdfNextPageBtn.disabled = isLast;
  if (studioPdfPageImage) studioPdfPageImage.src = imgUrl;
}

/* ==========================================================================
   RAW EDITOR PERSISTENCE
   ========================================================================== */

/**
 * Show Save only where saving is meaningful, and only once something changed.
 *
 * Saving is refused in "Page Only" scope on purpose: the editor holds one page
 * there, and writing it back would replace the whole file with that page.
 */
function updateSaveButtonState() {
  const buttons = [document.getElementById("viewerSaveBtn"), document.getElementById("studioSaveBtn")];
  const canSave = viewerFormat === "raw" && viewerScope === "all";

  buttons.forEach((btn) => {
    if (!btn) return;
    btn.style.display = canSave ? "inline-flex" : "none";
    btn.disabled = !rawEditorDirty;
    btn.classList.toggle("btn-primary", rawEditorDirty);
    btn.classList.toggle("btn-secondary", !rawEditorDirty);
    btn.title = rawEditorDirty ? "Save edits to the .md file on disk" : "No unsaved changes";
  });
}

function markRawEditorDirty() {
  if (viewerScope !== "all") return;
  rawEditorDirty = true;
  updateSaveButtonState();
}

async function saveRawMarkdown() {
  const { textarea } = getActiveContext();
  const targetPath = appState.currentViewingMarkdownPath;

  if (!textarea || !targetPath) return;
  if (viewerScope !== "all") {
    showToast("Cannot save a single page", "Switch to Full Doc scope before saving.", true);
    return;
  }

  const content = textarea.value;
  try {
    const res = await fetch("/api/markdown", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_path: targetPath, content })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `Save failed (${res.status})`);
    }

    appState.currentViewingMarkdownContent = content;
    pagesMap = parseMarkdownPages(content);
    rawEditorDirty = false;
    updateSaveButtonState();

    // Rebuild the rendered side from the saved text so the two views cannot
    // drift apart. The editor already holds it, so it is left alone.
    [transcripts.viewer, transcripts.studio].forEach((view) => {
      if (view) view.setDocument(pagesMap, { restrictToPage: null });
    });
    renderStudioPageList();

    showToast("Saved", "Markdown written to disk.");
  } catch (e) {
    showToast("Save failed", e.message, true);
  }
}

/* ==========================================================================
   SEARCH
   ========================================================================== */

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

  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.pointerEvents = "none";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";
  mirror.style.height = "auto";
  mirror.style.width = `${textarea.clientWidth}px`;
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";

  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  mirror.appendChild(document.createTextNode(textarea.value.slice(0, index)));
  mirror.appendChild(marker);

  document.body.appendChild(mirror);
  const top = marker.offsetTop;
  mirror.remove();
  return top;
}

/**
 * Find matches in the raw editor.
 *
 * Raw mode used to fall through to the rendered pane, which is display:none
 * while the editor is up — so search reported a match count against text the
 * user could not see and scrolled nothing.
 */
function performRawSearch(query, matchCase, textarea) {
  const countEls = document.querySelectorAll("#viewerSearchCount, #studioSearchCount");
  const navBtns = document.querySelectorAll("#viewerSearchPrevBtn, #studioSearchPrevBtn, #viewerSearchNextBtn, #studioSearchNextBtn");

  searchState.rawMatches = [];
  searchState.currentIndex = -1;

  const trimmed = (query || "").trim();
  if (!trimmed || !textarea) {
    countEls.forEach((c) => (c.textContent = "0/0"));
    navBtns.forEach((b) => (b.disabled = true));
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
    countEls.forEach((c) => (c.textContent = "0 matches"));
    navBtns.forEach((b) => (b.disabled = true));
    return;
  }

  navBtns.forEach((b) => (b.disabled = false));
  activateRawMatch(0);
}

function activateRawMatch(index) {
  const { textarea } = getActiveContext();
  const match = searchState.rawMatches[index];
  if (!textarea || !match) return;

  searchState.currentIndex = index;

  const countStr = `${index + 1} of ${searchState.rawMatches.length}`;
  document.querySelectorAll("#viewerSearchCount, #studioSearchCount").forEach((c) => (c.textContent = countStr));

  // Focus first: an unfocused textarea shows no selection, so the match would
  // be scrolled to but invisible.
  textarea.focus();
  textarea.setSelectionRange(match.start, match.end);
  textarea.scrollTop = Math.max(0, measureTextareaOffsetTop(textarea, match.start) - textarea.clientHeight / 2);
}

export function openSearchBar() {
  searchState.isOpen = true;
  const isStudio = appState.currentView === "studio";

  const bar = isStudio ? document.getElementById("studioSearchBar") : document.getElementById("viewerSearchBar");
  const input = isStudio ? document.getElementById("studioSearchInput") : document.getElementById("viewerSearchInput");
  const btn = isStudio ? document.getElementById("studioSearchToggleBtn") : document.getElementById("viewerSearchToggleBtn");

  if (bar) bar.style.display = "flex";
  if (btn) btn.classList.add("active");

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

  document.querySelectorAll("#viewerSearchBar, #studioSearchBar").forEach((b) => (b.style.display = "none"));
  document.querySelectorAll("#viewerSearchToggleBtn, #studioSearchToggleBtn").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll("#viewerSearchCount, #studioSearchCount").forEach((c) => (c.textContent = "0/0"));
  document.querySelectorAll("#viewerSearchPrevBtn, #studioSearchPrevBtn, #viewerSearchNextBtn, #studioSearchNextBtn").forEach((b) => (b.disabled = true));

  [transcripts.viewer, transcripts.studio].forEach((view) => {
    if (view) view.clearSearch();
  });
  clearSearchHighlights();
}

/** Belt and braces: strip any stray marks left in either rendered container. */
function clearSearchHighlights() {
  const containers = [document.getElementById("viewerMarkdownContent"), document.getElementById("studioMarkdownContent")];
  containers.forEach((container) => {
    if (!container) return;
    const marks = container.querySelectorAll("mark.viewer-search-match");
    marks.forEach((mark) => {
      const parent = mark.parentNode;
      if (parent) {
        parent.replaceChild(document.createTextNode(mark.textContent), mark);
        parent.normalize();
      }
    });
  });
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toggleSearchCase(btn, input) {
  searchState.matchCase = !searchState.matchCase;
  document.querySelectorAll("#viewerSearchCaseBtn, #studioSearchCaseBtn").forEach((b) => {
    b.classList.toggle("active", searchState.matchCase);
    b.setAttribute("aria-pressed", searchState.matchCase ? "true" : "false");
  });
  performSearch(input?.value || searchState.query || "", searchState.matchCase);
}

function handleSearchInput(val) {
  clearTimeout(searchState.debounceTimer);
  searchState.debounceTimer = setTimeout(() => {
    performSearch(val, searchState.matchCase);
  }, 120);
}

function handleSearchKeydown(e) {
  if (e.key === "Enter") {
    e.preventDefault();
    navigateMatch(e.shiftKey ? -1 : 1);
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeSearchBar();
  }
}

export function performSearch(query, matchCase = false) {
  searchState.query = (query || "").trim();

  const countEls = document.querySelectorAll("#viewerSearchCount, #studioSearchCount");
  const navBtns = document.querySelectorAll("#viewerSearchPrevBtn, #studioSearchPrevBtn, #viewerSearchNextBtn, #studioSearchNextBtn");

  // The raw editor is a textarea; it holds no <mark> nodes and the rendered
  // pane it used to search is hidden while the editor is up.
  if (viewerFormat === "raw") {
    performRawSearch(query, matchCase, getActiveContext().textarea);
    return;
  }

  const view = getActiveTranscript();
  if (!view) return;

  if (!searchState.query) {
    view.clearSearch();
    countEls.forEach((c) => (c.textContent = "0/0"));
    navBtns.forEach((b) => (b.disabled = true));
    return;
  }

  // Matching runs over a per-page text index rather than the DOM, so pages
  // that were never rendered still count — and only the visited match is
  // wrapped, instead of thousands of <mark> nodes at once.
  const { total, indexing } = view.search(searchState.query, matchCase);

  if (total === 0) {
    countEls.forEach((c) => (c.textContent = indexing ? "indexing…" : "0 matches"));
    navBtns.forEach((b) => (b.disabled = true));
    return;
  }

  navBtns.forEach((b) => (b.disabled = false));
  view.goToHit(0);
  syncSearchCountFromView(view);
}

export function navigateMatch(direction = 1) {
  if (viewerFormat === "raw") {
    const rawCount = searchState.rawMatches.length;
    if (rawCount === 0) return;
    activateRawMatch((searchState.currentIndex + direction + rawCount) % rawCount);
    return;
  }

  const view = getActiveTranscript();
  if (!view || view.searchHits.length === 0) return;
  view.nextHit(direction);
  syncSearchCountFromView(view);
}

/** Mirror the view's search position into the toolbar, and follow it with the PDF. */
function syncSearchCountFromView(view) {
  const countStr = `${view.currentHitIndex + 1} of ${view.searchHits.length}`;
  document.querySelectorAll("#viewerSearchCount, #studioSearchCount").forEach((c) => (c.textContent = countStr));

  const page = view.getCurrentHitPage();
  if (page && page !== appState.currentPdfPage && page >= 1 && page <= appState.totalPdfPages) {
    appState.currentPdfPage = page;
    updatePdfPageView();
    updateStudioOutlineActiveItem();
  }
}
