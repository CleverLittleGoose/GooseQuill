/**
 * GooseQuill - Document Viewer & Side-by-Side Comparison Modal Component
 * With Bi-Directional Auto-Scroll Page Reflection
 */

import { appState, eventBus } from "../state.js";
import { showToast } from "../services/notifications.js";
import { markdownRenderer } from "../services/markdown_renderer.js";

let autoSyncEnabled = true;
let isProgrammaticScroll = false;
let scrollTimeout = null;

export function initViewerModal() {
  const viewerModal = document.getElementById("viewerModal");
  const closeViewerBtn = document.getElementById("closeViewerBtn");
  const viewerTogglePdfBtn = document.getElementById("viewerTogglePdfBtn");
  const viewerAutoScrollBtn = document.getElementById("viewerAutoScrollBtn");
  const viewerCopyBtn = document.getElementById("viewerCopyBtn");
  const viewerDownloadBtn = document.getElementById("viewerDownloadBtn");
  const pdfPrevPageBtn = document.getElementById("pdfPrevPageBtn");
  const pdfNextPageBtn = document.getElementById("pdfNextPageBtn");
  const viewerPdfPane = document.getElementById("viewerPdfPane");
  const viewerMarkdownPane = document.getElementById("viewerMarkdownPane");

  if (closeViewerBtn) {
    closeViewerBtn.addEventListener("click", () => {
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

  // Keyboard navigation for viewer modal (Arrow Left / Right / PageUp / PageDown / Esc)
  window.addEventListener("keydown", (e) => {
    if (viewerModal && viewerModal.style.display === "flex") {
      if (e.key === "ArrowLeft" || e.key === "PageUp") {
        goToPage(appState.currentPdfPage - 1, true);
      } else if (e.key === "ArrowRight" || e.key === "PageDown") {
        goToPage(appState.currentPdfPage + 1, true);
      } else if (e.key === "Escape") {
        viewerModal.style.display = "none";
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
