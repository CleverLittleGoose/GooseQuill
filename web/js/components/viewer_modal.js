/**
 * GooseQuill - Document Viewer & Side-by-Side Comparison Modal Component
 * With Bi-Directional Auto-Scroll Page Reflection & In-Viewer Text Search
 */

import { appState, eventBus } from "../state.js";
import { showToast } from "../services/notifications.js";
import { markdownRenderer } from "../services/markdown_renderer.js";

let autoSyncEnabled = true;
let isProgrammaticScroll = false;
let scrollTimeout = null;

// Search State
const searchState = {
  isOpen: false,
  query: "",
  matchCase: false,
  matches: [],
  currentIndex: -1,
  debounceTimer: null
};

export function initViewerModal() {
  const viewerModal = document.getElementById("viewerModal");
  const closeViewerBtn = document.getElementById("closeViewerBtn");
  const viewerTogglePdfBtn = document.getElementById("viewerTogglePdfBtn");
  const viewerAutoScrollBtn = document.getElementById("viewerAutoScrollBtn");
  const viewerSearchToggleBtn = document.getElementById("viewerSearchToggleBtn");
  const viewerCopyBtn = document.getElementById("viewerCopyBtn");
  const viewerDownloadBtn = document.getElementById("viewerDownloadBtn");
  const pdfPrevPageBtn = document.getElementById("pdfPrevPageBtn");
  const pdfNextPageBtn = document.getElementById("pdfNextPageBtn");
  const viewerPdfPane = document.getElementById("viewerPdfPane");
  const viewerMarkdownPane = document.getElementById("viewerMarkdownPane");

  // Search UI Elements
  const viewerSearchBar = document.getElementById("viewerSearchBar");
  const viewerSearchInput = document.getElementById("viewerSearchInput");
  const viewerSearchCaseBtn = document.getElementById("viewerSearchCaseBtn");
  const viewerSearchPrevBtn = document.getElementById("viewerSearchPrevBtn");
  const viewerSearchNextBtn = document.getElementById("viewerSearchNextBtn");
  const viewerSearchCloseBtn = document.getElementById("viewerSearchCloseBtn");

  if (closeViewerBtn) {
    closeViewerBtn.addEventListener("click", () => {
      closeSearchBar();
      if (viewerModal) viewerModal.style.display = "none";
    });
  }

  // Toggle Auto-Sync
  if (viewerAutoScrollBtn) {
    viewerAutoScrollBtn.addEventListener("click", () => {
      autoSyncEnabled = !autoSyncEnabled;
      viewerAutoScrollBtn.classList.toggle("active", autoSyncEnabled);
      viewerAutoScrollBtn.textContent = autoSyncEnabled ? "⚡ Auto-Sync" : "⚡ Auto-Sync (Off)";
    });
  }

  // Search Bar Toggle & Controls
  if (viewerSearchToggleBtn) {
    viewerSearchToggleBtn.addEventListener("click", () => {
      if (searchState.isOpen) {
        closeSearchBar();
      } else {
        openSearchBar();
      }
    });
  }

  if (viewerSearchCloseBtn) {
    viewerSearchCloseBtn.addEventListener("click", () => closeSearchBar());
  }

  if (viewerSearchCaseBtn) {
    viewerSearchCaseBtn.addEventListener("click", () => {
      searchState.matchCase = !searchState.matchCase;
      viewerSearchCaseBtn.classList.toggle("active", searchState.matchCase);
      viewerSearchCaseBtn.setAttribute("aria-pressed", searchState.matchCase ? "true" : "false");
      performSearch(viewerSearchInput?.value || "", searchState.matchCase);
    });
  }

  if (viewerSearchNextBtn) {
    viewerSearchNextBtn.addEventListener("click", () => navigateMatch(1));
  }

  if (viewerSearchPrevBtn) {
    viewerSearchPrevBtn.addEventListener("click", () => navigateMatch(-1));
  }

  if (viewerSearchInput) {
    viewerSearchInput.addEventListener("input", (e) => {
      clearTimeout(searchState.debounceTimer);
      searchState.debounceTimer = setTimeout(() => {
        performSearch(e.target.value, searchState.matchCase);
      }, 120);
    });

    viewerSearchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        navigateMatch(e.shiftKey ? -1 : 1);
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeSearchBar();
      }
    });
  }

  // Toggle PDF Split Pane
  if (viewerTogglePdfBtn) {
    viewerTogglePdfBtn.addEventListener("click", () => {
      if (!viewerPdfPane) return;
      const isVisible = viewerPdfPane.style.display !== "none";
      viewerPdfPane.style.display = isVisible ? "none" : "flex";
      viewerTogglePdfBtn.textContent = isVisible ? "Show PDF Split" : "Hide PDF Split";
      if (!isVisible) updatePdfPageView();
    });
  }

  // PDF Page Navigation Controls
  if (pdfPrevPageBtn) {
    pdfPrevPageBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      goToPage(appState.currentPdfPage - 1, true);
    });
  }

  if (pdfNextPageBtn) {
    pdfNextPageBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      goToPage(appState.currentPdfPage + 1, true);
    });
  }

  // Copy / Download Actions
  if (viewerCopyBtn) {
    viewerCopyBtn.addEventListener("click", () => {
      if (appState.currentViewingMarkdownContent) {
        navigator.clipboard.writeText(appState.currentViewingMarkdownContent);
        viewerCopyBtn.textContent = "Copied!";
        setTimeout(() => (viewerCopyBtn.textContent = "Copy Markdown"), 2000);
      }
    });
  }

  if (viewerDownloadBtn) {
    viewerDownloadBtn.addEventListener("click", () => {
      if (!appState.currentViewingMarkdownContent) return;
      const title = (document.getElementById("viewerDocTitle")?.textContent || "document").replace(".pdf", ".md");
      const blob = new Blob([appState.currentViewingMarkdownContent], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = title;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  // Keyboard navigation for viewer modal (Cmd+F / Arrow Left / Right / PageUp / PageDown / Esc)
  window.addEventListener("keydown", (e) => {
    if (viewerModal && viewerModal.style.display === "flex") {
      // Cmd+F / Ctrl+F -> In-Viewer Text Search
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        openSearchBar();
        return;
      }

      if (e.key === "Escape") {
        if (searchState.isOpen) {
          e.preventDefault();
          closeSearchBar();
        } else {
          viewerModal.style.display = "none";
        }
      } else if (!searchState.isOpen || document.activeElement !== viewerSearchInput) {
        if (e.key === "ArrowLeft" || e.key === "PageUp") {
          goToPage(appState.currentPdfPage - 1, true);
        } else if (e.key === "ArrowRight" || e.key === "PageDown") {
          goToPage(appState.currentPdfPage + 1, true);
        }
      }
    }
  });

  // Scroll Sync: As user scrolls markdown text, reflect the current page on the PDF preview
  if (viewerMarkdownPane) {
    let isTicking = false;
    viewerMarkdownPane.addEventListener(
      "scroll",
      () => {
        if (!autoSyncEnabled || isProgrammaticScroll) return;
        if (!isTicking) {
          window.requestAnimationFrame(() => {
            detectActivePageFromMarkdownScroll();
            isTicking = false;
          });
          isTicking = true;
        }
      },
      { passive: true }
    );
  }

  eventBus.on("modal:viewer:open", (doc) => openDocumentViewer(doc));
}

/**
 * Open the in-viewer search toolbar and focus the input field
 */
export function openSearchBar() {
  const viewerSearchBar = document.getElementById("viewerSearchBar");
  const viewerSearchInput = document.getElementById("viewerSearchInput");
  const viewerSearchToggleBtn = document.getElementById("viewerSearchToggleBtn");

  searchState.isOpen = true;
  if (viewerSearchBar) viewerSearchBar.style.display = "flex";
  if (viewerSearchToggleBtn) viewerSearchToggleBtn.classList.add("active");

  if (viewerSearchInput) {
    viewerSearchInput.focus();
    viewerSearchInput.select();
    if (viewerSearchInput.value) {
      performSearch(viewerSearchInput.value, searchState.matchCase);
    }
  }
}

/**
 * Close search toolbar, clear matches, and return focus
 */
export function closeSearchBar() {
  const viewerSearchBar = document.getElementById("viewerSearchBar");
  const viewerSearchToggleBtn = document.getElementById("viewerSearchToggleBtn");
  const viewerSearchCount = document.getElementById("viewerSearchCount");
  const viewerSearchPrevBtn = document.getElementById("viewerSearchPrevBtn");
  const viewerSearchNextBtn = document.getElementById("viewerSearchNextBtn");

  searchState.isOpen = false;
  searchState.query = "";
  searchState.matches = [];
  searchState.currentIndex = -1;

  if (viewerSearchBar) viewerSearchBar.style.display = "none";
  if (viewerSearchToggleBtn) viewerSearchToggleBtn.classList.remove("active");
  if (viewerSearchCount) viewerSearchCount.textContent = "0/0";
  if (viewerSearchPrevBtn) viewerSearchPrevBtn.disabled = true;
  if (viewerSearchNextBtn) viewerSearchNextBtn.disabled = true;

  clearSearchHighlights();
}

/**
 * Cleanly remove all <mark> nodes and normalize DOM text
 */
function clearSearchHighlights() {
  const container = document.getElementById("viewerMarkdownContent");
  if (!container) return;

  const marks = container.querySelectorAll("mark.viewer-search-match");
  marks.forEach((mark) => {
    const parent = mark.parentNode;
    if (parent) {
      parent.replaceChild(document.createTextNode(mark.textContent), mark);
      parent.normalize();
    }
  });
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Perform non-destructive text search across the rendered markdown container
 */
export function performSearch(query, matchCase = false) {
  clearSearchHighlights();

  const container = document.getElementById("viewerMarkdownContent");
  const viewerSearchCount = document.getElementById("viewerSearchCount");
  const viewerSearchPrevBtn = document.getElementById("viewerSearchPrevBtn");
  const viewerSearchNextBtn = document.getElementById("viewerSearchNextBtn");

  const trimmed = (query || "").trim();
  searchState.query = trimmed;
  searchState.matches = [];
  searchState.currentIndex = -1;

  if (!trimmed || !container) {
    if (viewerSearchCount) viewerSearchCount.textContent = "0/0";
    if (viewerSearchPrevBtn) viewerSearchPrevBtn.disabled = true;
    if (viewerSearchNextBtn) viewerSearchNextBtn.disabled = true;
    return;
  }

  // Walk all text nodes inside container
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_SKIP;
      const parent = node.parentElement;
      if (
        parent &&
        (parent.tagName === "SCRIPT" ||
          parent.tagName === "STYLE" ||
          parent.classList.contains("doc-page-badge") ||
          parent.classList.contains("search-count"))
      ) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const textNodes = [];
  let currentNode;
  while ((currentNode = walker.nextNode())) {
    textNodes.push(currentNode);
  }

  const flags = matchCase ? "g" : "gi";
  const regex = new RegExp(escapeRegExp(trimmed), flags);
  const foundMatches = [];

  textNodes.forEach((node) => {
    const text = node.nodeValue;
    if (!regex.test(text)) return;
    regex.lastIndex = 0;

    const fragment = document.createDocumentFragment();
    let lastIdx = 0;
    let match;

    while ((match = regex.exec(text)) !== null) {
      const matchStart = match.index;
      const matchEnd = match.index + match[0].length;

      if (matchStart > lastIdx) {
        fragment.appendChild(document.createTextNode(text.substring(lastIdx, matchStart)));
      }

      const mark = document.createElement("mark");
      mark.className = "viewer-search-match";
      mark.textContent = match[0];
      fragment.appendChild(mark);
      foundMatches.push(mark);

      lastIdx = matchEnd;
    }

    if (lastIdx < text.length) {
      fragment.appendChild(document.createTextNode(text.substring(lastIdx)));
    }

    if (node.parentNode) {
      node.parentNode.replaceChild(fragment, node);
    }
  });

  searchState.matches = foundMatches;

  if (foundMatches.length > 0) {
    if (viewerSearchPrevBtn) viewerSearchPrevBtn.disabled = false;
    if (viewerSearchNextBtn) viewerSearchNextBtn.disabled = false;
    activateMatch(0, true);
  } else {
    if (viewerSearchCount) viewerSearchCount.textContent = "0 matches";
    if (viewerSearchPrevBtn) viewerSearchPrevBtn.disabled = true;
    if (viewerSearchNextBtn) viewerSearchNextBtn.disabled = true;
  }
}

/**
 * Navigate to next (+1) or previous (-1) match
 */
export function navigateMatch(direction = 1) {
  if (searchState.matches.length === 0) return;
  const count = searchState.matches.length;
  const nextIdx = (searchState.currentIndex + direction + count) % count;
  activateMatch(nextIdx, true);
}

/**
 * Highlight the active match and synchronize both markdown and PDF preview panes
 */
function activateMatch(index, scrollToMatch = true) {
  if (index < 0 || index >= searchState.matches.length) return;

  // Clear previous active highlight
  searchState.matches.forEach((m) => m.classList.remove("viewer-search-match-active"));

  searchState.currentIndex = index;
  const activeMark = searchState.matches[index];
  activeMark.classList.add("viewer-search-match-active");

  // Update live announcement counter
  const viewerSearchCount = document.getElementById("viewerSearchCount");
  if (viewerSearchCount) {
    viewerSearchCount.textContent = `${index + 1} of ${searchState.matches.length}`;
  }

  // Detect which page section contains this match
  const pageNum = detectMatchPageNumber(activeMark);
  if (pageNum && pageNum !== appState.currentPdfPage && pageNum >= 1 && pageNum <= appState.totalPdfPages) {
    appState.currentPdfPage = pageNum;
    updatePdfPageView();
  }

  // Smooth scroll markdown pane to center the active match
  if (scrollToMatch) {
    isProgrammaticScroll = true;
    activeMark.scrollIntoView({ behavior: "smooth", block: "center" });
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => {
      isProgrammaticScroll = false;
    }, 600);
  }
}

/**
 * Helper to determine which Page N section contains a match element
 */
function detectMatchPageNumber(element) {
  const container = document.getElementById("viewerMarkdownContent");
  if (!container || !element) return 1;

  let current = element;
  while (current && current !== container) {
    if (current.dataset && current.dataset.page) {
      return parseInt(current.dataset.page, 10);
    }
    // Check previous siblings
    let prev = current.previousElementSibling;
    while (prev) {
      if (prev.dataset && prev.dataset.page) {
        return parseInt(prev.dataset.page, 10);
      }
      const childPage = prev.querySelector("[data-page]");
      if (childPage && childPage.dataset.page) {
        return parseInt(childPage.dataset.page, 10);
      }
      prev = prev.previousElementSibling;
    }
    current = current.parentElement;
  }
  return 1;
}

/**
 * Navigate to a specific PDF page, update the canvas preview, and optionally scroll markdown
 */
export function goToPage(pageNumber, scrollToMarkdown = true) {
  if (pageNumber < 1 || pageNumber > appState.totalPdfPages) return;
  appState.currentPdfPage = pageNumber;
  updatePdfPageView();

  if (scrollToMarkdown && autoSyncEnabled) {
    const targetEl = document.getElementById(`doc-page-${pageNumber}`);
    if (targetEl) {
      isProgrammaticScroll = true;
      targetEl.scrollIntoView({ behavior: "smooth", block: "start" });
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        isProgrammaticScroll = false;
      }, 700);
    }
  }
}

/**
 * Detect which page marker is currently in view inside the markdown scroll container
 */
function detectActivePageFromMarkdownScroll() {
  const viewerMarkdownPane = document.getElementById("viewerMarkdownPane");
  const viewerMarkdownContent = document.getElementById("viewerMarkdownContent");
  if (!viewerMarkdownPane || !viewerMarkdownContent) return;

  const pageMarkers = viewerMarkdownContent.querySelectorAll("[data-page]");
  if (!pageMarkers || pageMarkers.length === 0) return;

  const paneRect = viewerMarkdownPane.getBoundingClientRect();
  const threshold = paneRect.top + 120; // 120px offset from the top edge

  let activePage = 1;
  pageMarkers.forEach((marker) => {
    const rect = marker.getBoundingClientRect();
    if (rect.top <= threshold) {
      const p = parseInt(marker.dataset.page, 10);
      if (!isNaN(p)) activePage = p;
    }
  });

  if (activePage !== appState.currentPdfPage && activePage >= 1 && activePage <= appState.totalPdfPages) {
    appState.currentPdfPage = activePage;
    updatePdfPageView();
  }
}

/**
 * Parses rendered markdown DOM and decorates page headers with data-page attributes and badges
 */
function tagPageSections(container) {
  if (!container) return;
  const elements = container.querySelectorAll("h1, h2, h3, h4, h5, h6, p");
  const foundPages = new Set();

  elements.forEach((el) => {
    const text = el.textContent.trim();
    // Match patterns: "Page 1", "Page 1 of 20", "Page 1: Title", "## Page 1"
    const match = text.match(/^Page\s+(\d+)(?:\s*(?:of|\/|\:|\-)\s*\d+)?/i) || text.match(/^##+\s*Page\s+(\d+)/i);
    if (match) {
      const pageNum = parseInt(match[1], 10);
      if (!isNaN(pageNum) && !foundPages.has(pageNum)) {
        foundPages.add(pageNum);
        el.dataset.page = pageNum;
        el.id = `doc-page-${pageNum}`;
        el.classList.add("doc-page-heading");

        // Add subtle indicator badge if not already added
        if (!el.querySelector(".doc-page-badge")) {
          const badge = document.createElement("span");
          badge.className = "doc-page-badge";
          badge.textContent = `PAGE ${pageNum}`;
          el.appendChild(badge);
        }
      }
    }
  });

  // Ensure page 1 anchor exists at top if no explicit "Page 1" header
  if (!foundPages.has(1) && container.firstElementChild) {
    container.firstElementChild.dataset.page = 1;
    container.firstElementChild.id = "doc-page-1";
  }
}

export async function openDocumentViewer(doc) {
  const viewerModal = document.getElementById("viewerModal");
  const viewerDocTitle = document.getElementById("viewerDocTitle");
  const viewerDocMeta = document.getElementById("viewerDocMeta");
  const viewerMarkdownContent = document.getElementById("viewerMarkdownContent");
  const viewerTogglePdfBtn = document.getElementById("viewerTogglePdfBtn");
  const viewerPdfPane = document.getElementById("viewerPdfPane");
  const viewerMarkdownPane = document.getElementById("viewerMarkdownPane");

  let pdfPath = doc.path;
  if (pdfPath && pdfPath.toLowerCase().endsWith(".md")) {
    pdfPath = pdfPath.replace(/[/\\]Markdown[/\\]/, "/").replace(/\.md$/i, ".pdf");
  }

  appState.currentViewingDoc = doc;
  appState.currentViewingPdfPath = pdfPath;
  appState.currentViewingMarkdownPath = doc.output_path || doc.path;
  appState.currentPdfPage = 1;
  appState.totalPdfPages = doc.total_pages || 1;

  if (viewerDocTitle) viewerDocTitle.textContent = doc.name;
  if (viewerDocMeta) viewerDocMeta.textContent = `${doc.total_pages || 1} pages • ${(doc.file_size / 1024).toFixed(0)} KB • ${doc.folder}`;

  if (viewerMarkdownContent) {
    viewerMarkdownContent.innerHTML = `<div class="text-muted text-center" style="padding: 60px;">Loading markdown transcription...</div>`;
  }

  // Ensure split view is active by default
  if (viewerPdfPane) {
    if (viewerPdfPane.style.display === "none") {
      if (viewerTogglePdfBtn) viewerTogglePdfBtn.textContent = "Show PDF Split";
    } else {
      viewerPdfPane.style.display = "flex";
      if (viewerTogglePdfBtn) viewerTogglePdfBtn.textContent = "Hide PDF Split";
    }
  }

  if (viewerModal) viewerModal.style.display = "flex";
  if (viewerMarkdownPane) viewerMarkdownPane.scrollTop = 0;
  updatePdfPageView();

  try {
    const res = await fetch(`/api/markdown?path=${encodeURIComponent(doc.path)}`);
    if (!res.ok) throw new Error("Could not load markdown");
    const data = await res.json();

    appState.currentViewingMarkdownContent = data.content;

    if (viewerMarkdownContent) {
      viewerMarkdownContent.innerHTML = markdownRenderer.render(data.content);
      tagPageSections(viewerMarkdownContent);
    }
  } catch (e) {
    if (viewerMarkdownContent) {
      viewerMarkdownContent.innerHTML = `<div class="text-danger text-center" style="padding: 40px;">Error loading markdown: ${e.message}</div>`;
    }
  }
}

export function updatePdfPageView() {
  if (!appState.currentViewingPdfPath) return;
  const pdfPageIndicator = document.getElementById("pdfPageIndicator");
  const pdfPageImage = document.getElementById("pdfPageImage");
  const pdfPrevPageBtn = document.getElementById("pdfPrevPageBtn");
  const pdfNextPageBtn = document.getElementById("pdfNextPageBtn");

  if (pdfPageIndicator) pdfPageIndicator.textContent = `Page ${appState.currentPdfPage} of ${appState.totalPdfPages}`;
  if (pdfPrevPageBtn) pdfPrevPageBtn.disabled = appState.currentPdfPage <= 1;
  if (pdfNextPageBtn) pdfNextPageBtn.disabled = appState.currentPdfPage >= appState.totalPdfPages;

  if (pdfPageImage) {
    pdfPageImage.src = `/api/page_image?path=${encodeURIComponent(appState.currentViewingPdfPath)}&page=${appState.currentPdfPage}`;
  }
}
