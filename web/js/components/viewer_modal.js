/**
 * GooseQuill - Document Viewer & Document Studio Workspace Component
 * Dual Paradigm: Lightweight Modal Viewer + Fullscreen Document Studio
 * Features: Rendered/Raw Markdown, Scope Toggle, Auto-Sync Scrolling, In-Viewer Search
 */

import { appState, eventBus } from "../state.js";
import { showToast } from "../services/notifications.js";
import { TranscriptView } from "../services/transcript_view.js";
import { ComparePane } from "./compare_pane.js";
import { populateDocumentSelect, findDocumentByPath, resolvePdfPath } from "../services/document_catalog.js";
import { comparePageSets, diffPageHtml } from "../services/text_diff.js";
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

// Studio's second document. Null until Compare is switched on.
let comparePane = null;
let compareEnabled = false;
let linkPagesEnabled = true;
let diffEnabled = false;
let diffChangedPages = [];
// Page pairs are diffed on demand and kept, so scrolling back over a page does
// not pay for the comparison twice.
const diffCache = new Map();

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
        btn.textContent = autoSyncEnabled ? "⚡ Sync" : "⚡ Sync (Off)";
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
      studioTogglePdfBtn.classList.toggle("active", !isVisible);
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

  // Pane A document picker — symmetric with pane B's.
  const studioDocSelect = document.getElementById("studioDocSelect");
  if (studioDocSelect) {
    studioDocSelect.addEventListener("change", () => {
      const doc = findDocumentByPath(studioDocSelect.value);
      if (doc) openDocumentInStudio(doc);
    });
  }

  initStudioSplitters();

  // PDF zoom
  document.querySelectorAll(".pdf-zoom-controls [data-zoom]").forEach((btn) => {
    btn.addEventListener("click", () => setZoom(btn.dataset.zoom));
  });

  // Diff mode
  const studioDiffBtn = document.getElementById("studioDiffBtn");
  if (studioDiffBtn) studioDiffBtn.addEventListener("click", () => setDiffEnabled(!diffEnabled));
  const studioDiffPrevBtn = document.getElementById("studioDiffPrevBtn");
  const studioDiffNextBtn = document.getElementById("studioDiffNextBtn");
  if (studioDiffPrevBtn) studioDiffPrevBtn.addEventListener("click", () => goToChangedPage(-1));
  if (studioDiffNextBtn) studioDiffNextBtn.addEventListener("click", () => goToChangedPage(1));

  // Compare (second document)
  const studioCompareBtn = document.getElementById("studioCompareBtn");
  const studioLinkPagesBtn = document.getElementById("studioLinkPagesBtn");
  if (studioCompareBtn) {
    studioCompareBtn.addEventListener("click", () => setCompareEnabled(!compareEnabled));
  }
  if (studioLinkPagesBtn) {
    studioLinkPagesBtn.addEventListener("click", () => {
      linkPagesEnabled = !linkPagesEnabled;
      updateLinkPagesButton();
      if (linkPagesEnabled) syncComparePane(appState.currentPdfPage);
    });
  }

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

  // The assembler writes both "<!-- Page N -->" and "## Page N", and the
  // pattern matches each of them. Left as two splits, page N would be cut in
  // half and the half that survived would lose its comment marker — which is
  // what the fence unwrapper keys on. Keep only the first split per page.
  const deduped = splits.filter((split, i) => i === 0 || split.pageNum !== splits[i - 1].pageNum);
  splits.length = 0;
  splits.push(...deduped);

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
// Thumbnails are rendered server-side at this dpi: about 12KB per page against
// 190KB for a full preview, and legible enough to recognise a page by shape.
const THUMBNAIL_DPI = 20;

let thumbnailObserver = null;

/**
 * Build the page index.
 *
 * Every row used to read "Page N ✓", with the tick on all of them — a list
 * carrying no information you could navigate by. Rows now show the page itself,
 * fetched only when the row scrolls into view so a 200-page filing does not
 * fire 200 renders on open.
 */
function renderStudioPageList() {
  const pageListContainer = document.getElementById("studioPageList");
  const studioPageCount = document.getElementById("studioPageCount");
  if (!pageListContainer) return;

  if (thumbnailObserver) thumbnailObserver.disconnect();
  pageListContainer.innerHTML = "";

  const total = appState.totalPdfPages || 1;
  if (studioPageCount) studioPageCount.textContent = total;

  thumbnailObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const img = entry.target.querySelector(".studio-page-thumb");
        if (img && !img.src && img.dataset.src) img.src = img.dataset.src;
        thumbnailObserver.unobserve(entry.target);
      });
    },
    { root: pageListContainer, rootMargin: "400px 0px" }
  );

  const pdfPath = appState.currentViewingPdfPath;
  const fragment = document.createDocumentFragment();

  for (let page = 1; page <= total; page++) {
    const item = document.createElement("div");
    item.className = `studio-page-item ${page === appState.currentPdfPage ? "active" : ""}`;
    item.dataset.page = page;

    const thumbSrc = pdfPath
      ? `/api/page_image?path=${encodeURIComponent(pdfPath)}&page=${page}&dpi=${THUMBNAIL_DPI}`
      : "";

    item.innerHTML = `
      <div class="studio-page-thumb-frame">
        <img class="studio-page-thumb" data-src="${thumbSrc}" alt="" loading="lazy" decoding="async">
      </div>
      <span class="studio-page-item-label">Page ${page}</span>
    `;

    item.addEventListener("click", () => goToPage(page, true));
    fragment.appendChild(item);
  }

  pageListContainer.appendChild(fragment);
  pageListContainer.querySelectorAll(".studio-page-item").forEach((item) => thumbnailObserver.observe(item));
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
  applyZoom();
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
  const pdfPath = resolvePdfPath(doc);

  appState.currentViewingDoc = doc;
  appState.currentViewingPdfPath = pdfPath;
  appState.currentViewingMarkdownPath = doc.output_path || doc.path;
  appState.currentPdfPage = 1;
  appState.totalPdfPages = doc.total_pages || 1;

  // Update Header titles
  const metaText = `${doc.total_pages || 1} pages • ${(doc.file_size / 1024).toFixed(0)} KB • ${doc.folder}`;
  const vTitle = document.getElementById("viewerDocTitle");
  const vMeta = document.getElementById("viewerDocMeta");
  const sMeta = document.getElementById("studioDocMeta");

  if (vTitle) vTitle.textContent = doc.name;
  if (vMeta) vMeta.textContent = metaText;
  if (sMeta) sMeta.textContent = metaText;

  // Pane A names itself through its picker, the same way pane B does.
  const studioDocSelect = document.getElementById("studioDocSelect");
  if (studioDocSelect) {
    populateDocumentSelect(studioDocSelect, { placeholder: "Choose a document…" });
    studioDocSelect.value = doc.path;
  }
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

    diffCache.clear();
    if (diffEnabled) setDiffEnabled(true);
  } catch (e) {
    const errHtml = `<div class="text-danger text-center" style="padding: 40px;">Error loading markdown: ${e.message}</div>`;
    if (viewerMarkdownContent) viewerMarkdownContent.innerHTML = errHtml;
    if (studioMarkdownContent) studioMarkdownContent.innerHTML = errHtml;
  }
}

function renderStudioView() {
  renderStudioPageList();
  updateViewerDisplay();
  applyZoom();
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
  syncComparePane(appState.currentPdfPage);
  if (!appState.currentViewingPdfPath) return;

  const pageStr = `Page ${appState.currentPdfPage} of ${appState.totalPdfPages}`;
  const imgUrl = `/api/page_image?path=${encodeURIComponent(appState.currentViewingPdfPath)}&page=${appState.currentPdfPage}&dpi=${dpiForZoom()}`;
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
  if (pdfPageImage && pdfPageImage.getAttribute("src") !== imgUrl) pdfPageImage.src = imgUrl;

  // Studio
  const studioPdfPageIndicator = document.getElementById("studioPdfPageIndicator");
  const studioPdfPageImage = document.getElementById("studioPdfPageImage");
  const studioPdfPrevPageBtn = document.getElementById("studioPdfPrevPageBtn");
  const studioPdfNextPageBtn = document.getElementById("studioPdfNextPageBtn");

  if (studioPdfPageIndicator) studioPdfPageIndicator.textContent = pageStr;
  if (studioPdfPrevPageBtn) studioPdfPrevPageBtn.disabled = isFirst;
  if (studioPdfNextPageBtn) studioPdfNextPageBtn.disabled = isLast;
  if (studioPdfPageImage && studioPdfPageImage.getAttribute("src") !== imgUrl) studioPdfPageImage.src = imgUrl;
}

/* ==========================================================================
   DIFF MODE
   ========================================================================== */

/**
 * Turn change highlighting on or off across both panes.
 *
 * Diff needs two documents, so it is only offered once Compare is on and pane B
 * actually holds something.
 */
function setDiffEnabled(enabled) {
  const diffBtn = document.getElementById("studioDiffBtn");
  const summary = document.getElementById("studioDiffSummary");
  const prevBtn = document.getElementById("studioDiffPrevBtn");
  const nextBtn = document.getElementById("studioDiffNextBtn");

  const canDiff = compareEnabled && comparePane && comparePane.doc;
  diffEnabled = enabled && canDiff;
  diffCache.clear();

  if (diffBtn) diffBtn.classList.toggle("active", diffEnabled);
  [summary, prevBtn, nextBtn].forEach((el) => {
    if (el) el.style.display = diffEnabled ? "inline-flex" : "none";
  });

  if (!diffEnabled) {
    diffChangedPages = [];
    // Back to plain transcripts on both sides.
    if (transcripts.studio) transcripts.studio.setDocument(pagesMap, { restrictToPage: null });
    if (comparePane && comparePane.doc) {
      comparePane.transcript.setDocument(comparePane.pagesMap, { restrictToPage: null });
      comparePane.setView("transcript");
    }
    if (summary) summary.textContent = "";
    return;
  }

  const pagesB = comparePane.pagesMap;
  const comparison = comparePageSets(pagesMap, pagesB);
  diffChangedPages = comparison.changedPages;

  if (summary) {
    const parts = [`${diffChangedPages.length}/${comparison.sharedPages.length} changed`];
    if (comparison.onlyInA.length) parts.push(`${comparison.onlyInA.length} only A`);
    if (comparison.onlyInB.length) parts.push(`${comparison.onlyInB.length} only B`);
    summary.textContent = parts.join(" · ");
    summary.title = `${diffChangedPages.length} of ${comparison.sharedPages.length} shared pages differ`;
  }

  // Both panes render the same page pair, each showing its own side.
  comparePane.setView("transcript");
  if (transcripts.studio) {
    transcripts.studio.setDocument(pagesMap, {
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
  if (diffCache.has(page)) return diffCache.get(page);

  const a = pagesMap[page];
  const b = comparePane ? comparePane.pagesMap[page] : undefined;

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
    result = diffPageHtml(a, b);
  }

  diffCache.set(page, result);
  return result;
}

function escapeDiffText(text) {
  return String(text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Jump both panes to the next or previous page that actually changed. */
function goToChangedPage(direction) {
  if (!diffEnabled || diffChangedPages.length === 0) return;

  const current = appState.currentPdfPage;
  let target;
  if (direction > 0) {
    target = diffChangedPages.find((p) => p > current);
    if (target === undefined) target = diffChangedPages[0];
  } else {
    const earlier = diffChangedPages.filter((p) => p < current);
    target = earlier.length ? earlier[earlier.length - 1] : diffChangedPages[diffChangedPages.length - 1];
  }

  goToPage(target, true);
  updateDiffNavButtons();
}

function updateDiffNavButtons() {
  const prevBtn = document.getElementById("studioDiffPrevBtn");
  const nextBtn = document.getElementById("studioDiffNextBtn");
  const hasChanges = diffEnabled && diffChangedPages.length > 0;
  [prevBtn, nextBtn].forEach((btn) => {
    if (btn) btn.disabled = !hasChanges;
  });
}

/** Diff is only meaningful with a document in each pane. */
function updateDiffAvailability() {
  const diffBtn = document.getElementById("studioDiffBtn");
  if (!diffBtn) return;
  const canDiff = compareEnabled && comparePane && comparePane.doc;
  diffBtn.style.display = compareEnabled ? "inline-flex" : "none";
  diffBtn.disabled = !canDiff;
  diffBtn.title = canDiff
    ? "Highlight what changed between the two documents"
    : "Choose a document in pane B first";
  if (!canDiff && diffEnabled) setDiffEnabled(false);
}

/* ==========================================================================
   PANE SPLITTERS
   ========================================================================== */

const SPLITTER_STORAGE_KEY = "goosequill.studio.panes";
const OUTLINE_MIN_WIDTH = 90;
const OUTLINE_MAX_WIDTH = 320;
const TRANSCRIPT_MIN_FRACTION = 0.2;
const TRANSCRIPT_MAX_FRACTION = 0.8;

function readPaneLayout() {
  try {
    return JSON.parse(localStorage.getItem(SPLITTER_STORAGE_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function writePaneLayout(patch) {
  try {
    localStorage.setItem(SPLITTER_STORAGE_KEY, JSON.stringify({ ...readPaneLayout(), ...patch }));
  } catch {
    // A full or blocked localStorage should not stop the pane from resizing.
  }
}

/** Restore the sizes the user last dragged to. */
function applyStoredPaneLayout() {
  const layout = readPaneLayout();
  const outline = document.getElementById("studioOutlinePane");
  const markdown = document.getElementById("studioMarkdownPane");

  if (outline && typeof layout.outlineWidth === "number") {
    outline.style.width = `${clamp(layout.outlineWidth, OUTLINE_MIN_WIDTH, OUTLINE_MAX_WIDTH)}px`;
  }
  if (markdown && typeof layout.transcriptFraction === "number") {
    const fraction = clamp(layout.transcriptFraction, TRANSCRIPT_MIN_FRACTION, TRANSCRIPT_MAX_FRACTION);
    markdown.style.flex = `1 1 ${(fraction * 100).toFixed(2)}%`;
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

/**
 * Make a divider draggable.
 *
 * Pointer capture keeps the drag alive when the cursor outruns the 6px handle,
 * which is most of the time.
 */
function initSplitter(splitterId, onDrag) {
  const splitter = document.getElementById(splitterId);
  if (!splitter) return;

  const start = (event) => {
    event.preventDefault();
    splitter.setPointerCapture(event.pointerId);
    splitter.classList.add("dragging");
    document.body.classList.add("is-resizing-panes");

    const move = (moveEvent) => onDrag(moveEvent.clientX);
    const end = (endEvent) => {
      splitter.releasePointerCapture(endEvent.pointerId);
      splitter.classList.remove("dragging");
      document.body.classList.remove("is-resizing-panes");
      splitter.removeEventListener("pointermove", move);
      splitter.removeEventListener("pointerup", end);
      splitter.removeEventListener("pointercancel", end);
    };

    splitter.addEventListener("pointermove", move);
    splitter.addEventListener("pointerup", end);
    splitter.addEventListener("pointercancel", end);
  };

  splitter.addEventListener("pointerdown", start);

  // Keyboard: a divider that only responds to a mouse is not usable by everyone.
  splitter.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 48 : 16;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      onDrag(splitter.getBoundingClientRect().left - step);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      onDrag(splitter.getBoundingClientRect().left + step);
    }
  });
}

function initStudioSplitters() {
  const outline = document.getElementById("studioOutlinePane");
  const markdown = document.getElementById("studioMarkdownPane");
  const body = document.querySelector(".studio-workspace-body");

  initSplitter("studioSplitterOutline", (clientX) => {
    if (!outline) return;
    const width = clamp(clientX - outline.getBoundingClientRect().left, OUTLINE_MIN_WIDTH, OUTLINE_MAX_WIDTH);
    outline.style.width = `${Math.round(width)}px`;
    writePaneLayout({ outlineWidth: Math.round(width) });
  });

  initSplitter("studioSplitterMain", (clientX) => {
    if (!markdown || !body) return;
    const markdownLeft = markdown.getBoundingClientRect().left;
    const available = body.getBoundingClientRect().right - markdownLeft;
    if (available <= 0) return;

    const fraction = clamp((clientX - markdownLeft) / available, TRANSCRIPT_MIN_FRACTION, TRANSCRIPT_MAX_FRACTION);
    markdown.style.flex = `1 1 ${(fraction * 100).toFixed(2)}%`;
    writePaneLayout({ transcriptFraction: fraction });
  });

  applyStoredPaneLayout();
}

/* ==========================================================================
   PDF ZOOM
   ========================================================================== */

// "fit-page" is the default because the previous behaviour — fit-to-width only —
// meant a portrait page was always taller than its pane, so you could never see
// a whole page at once in a tool whose job is checking pages.
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
let zoomMode = "fit-page";   // "fit-page" | "fit-width" | number index into ZOOM_STEPS
let zoomIndex = 2;           // used only when zoomMode === "scale"

/** Render dpi to ask the server for, given how far in we are zoomed. */
function dpiForZoom() {
  if (zoomMode !== "scale") return 150;
  const scale = ZOOM_STEPS[zoomIndex];
  // Past 1.5x a 150dpi raster starts to look soft; ask for more pixels instead.
  return scale > 1.5 ? 300 : 150;
}

function setZoom(action) {
  if (action === "fit-page" || action === "fit-width") {
    zoomMode = action;
  } else if (action === "in") {
    if (zoomMode !== "scale") {
      zoomMode = "scale";
      zoomIndex = 2;
    } else {
      zoomIndex = Math.min(zoomIndex + 1, ZOOM_STEPS.length - 1);
    }
  } else if (action === "out") {
    if (zoomMode !== "scale") {
      zoomMode = "scale";
      zoomIndex = 1;
    } else {
      zoomIndex = Math.max(zoomIndex - 1, 0);
    }
  }
  applyZoom();
}

function applyZoom() {
  const img = document.getElementById("studioPdfPageImage");
  const wrapper = document.getElementById("studioPdfCanvasWrapper");
  const label = document.getElementById("studioPdfZoomLevel");
  if (!img || !wrapper) return;

  wrapper.classList.toggle("zoom-fit-page", zoomMode === "fit-page");
  wrapper.classList.toggle("zoom-fit-width", zoomMode === "fit-width");
  wrapper.classList.toggle("zoom-scaled", zoomMode === "scale");

  if (zoomMode === "scale") {
    img.style.width = `${Math.round(ZOOM_STEPS[zoomIndex] * 100)}%`;
    img.style.maxWidth = "none";
    img.style.maxHeight = "none";
  } else {
    img.style.width = "";
    img.style.maxWidth = "";
    img.style.maxHeight = "";
  }

  if (label) {
    label.textContent =
      zoomMode === "scale" ? `${Math.round(ZOOM_STEPS[zoomIndex] * 100)}%`
        : zoomMode === "fit-width" ? "Width"
        : "Fit";
  }

  document.querySelectorAll(".pdf-zoom-controls [data-zoom]").forEach((btn) => {
    const isActive =
      (btn.dataset.zoom === "fit-page" && zoomMode === "fit-page") ||
      (btn.dataset.zoom === "fit-width" && zoomMode === "fit-width");
    btn.classList.toggle("active", isActive);
  });

  updatePdfPageView();
}

/* ==========================================================================
   COMPARE (SECOND DOCUMENT)
   ========================================================================== */

/**
 * Turn the side-by-side view on or off.
 *
 * Pane A stays whatever the Workspace opened; pane B carries its own picker.
 * Turning Compare on hides A's scan so the two transcripts get the full width —
 * A's scan is one click away on the existing "Show PDF Split" toggle.
 */
function setCompareEnabled(enabled) {
  const host = document.getElementById("studioComparePane");
  const compareBtn = document.getElementById("studioCompareBtn");
  const linkBtn = document.getElementById("studioLinkPagesBtn");
  const pdfPane = document.getElementById("studioPdfPane");
  const togglePdfBtn = document.getElementById("studioTogglePdfBtn");
  if (!host) return;

  compareEnabled = enabled;
  host.style.display = enabled ? "flex" : "none";
  if (compareBtn) compareBtn.classList.toggle("active", enabled);
  if (linkBtn) linkBtn.style.display = enabled ? "inline-flex" : "none";

  if (enabled) {
    if (!comparePane) {
      comparePane = new ComparePane(host, {
        label: "B",
        onPageChange: () => {
          // B driving A would fight A driving B; linking is one-way from A.
        },
        onDocumentLoaded: () => {
          updateDiffAvailability();
          // A document swap in B invalidates every cached comparison.
          diffCache.clear();
          if (diffEnabled) setDiffEnabled(true);
        }
      });
    }
    comparePane.populateDocuments();

    // Two documents need the width more than A's scan does.
    if (pdfPane) pdfPane.style.display = "none";
    if (togglePdfBtn) togglePdfBtn.classList.remove("active");
    updateLinkPagesButton();
    updateDiffAvailability();
  } else {
    if (diffEnabled) setDiffEnabled(false);
    updateDiffAvailability();
    if (pdfPane) {
      pdfPane.style.display = "flex";
      if (togglePdfBtn) togglePdfBtn.classList.add("active");
      updatePdfPageView();
    }
  }
}

function updateLinkPagesButton() {
  const linkBtn = document.getElementById("studioLinkPagesBtn");
  if (!linkBtn) return;
  linkBtn.classList.toggle("active", linkPagesEnabled);
  linkBtn.textContent = linkPagesEnabled ? "🔗 Link" : "🔗 Link (Off)";
}

/** Keep pane B on the same page number as pane A. */
function syncComparePane(page) {
  if (!compareEnabled || !linkPagesEnabled || !comparePane || !comparePane.doc) return;
  comparePane.goToPage(page);
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
