/**
 * GooseQuill - Document Viewer & Side-by-Side Comparison Modal Component
 */

import { appState, eventBus } from "../state.js";
import { showToast } from "../services/notifications.js";
import { markdownRenderer } from "../services/markdown_renderer.js";

export function initViewerModal() {
  const viewerModal = document.getElementById("viewerModal");
  const closeViewerBtn = document.getElementById("closeViewerBtn");
  const viewerTogglePdfBtn = document.getElementById("viewerTogglePdfBtn");
  const viewerCopyBtn = document.getElementById("viewerCopyBtn");
  const viewerDownloadBtn = document.getElementById("viewerDownloadBtn");
  const pdfPrevPageBtn = document.getElementById("pdfPrevPageBtn");
  const pdfNextPageBtn = document.getElementById("pdfNextPageBtn");
  const viewerPdfPane = document.getElementById("viewerPdfPane");

  if (closeViewerBtn) {
    closeViewerBtn.addEventListener("click", () => {
      if (viewerModal) viewerModal.style.display = "none";
    });
  }

  if (viewerTogglePdfBtn) {
    viewerTogglePdfBtn.addEventListener("click", () => {
      if (!viewerPdfPane) return;
      const isVisible = viewerPdfPane.style.display !== "none";
      viewerPdfPane.style.display = isVisible ? "none" : "flex";
      viewerTogglePdfBtn.textContent = isVisible ? "Show PDF Split" : "Hide PDF Split";
      if (!isVisible) updatePdfPageView();
    });
  }

  // PDF Page Navigation
  if (pdfPrevPageBtn) {
    pdfPrevPageBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (appState.currentPdfPage > 1) {
        appState.currentPdfPage--;
        updatePdfPageView();
      }
    });
  }

  if (pdfNextPageBtn) {
    pdfNextPageBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (appState.currentPdfPage < appState.totalPdfPages) {
        appState.currentPdfPage++;
        updatePdfPageView();
      }
    });
  }

  // Copy / Download
  if (viewerCopyBtn) {
    viewerCopyBtn.addEventListener("click", () => {
      if (appState.currentViewingMarkdownContent) {
        navigator.clipboard.writeText(appState.currentViewingMarkdownContent);
        viewerCopyBtn.textContent = "Copied!";
        setTimeout(() => viewerCopyBtn.textContent = "Copy Markdown", 2000);
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

  // Keyboard navigation for viewer modal (Arrow Left / Right / Esc)
  window.addEventListener("keydown", (e) => {
    if (viewerModal && viewerModal.style.display === "flex") {
      if (e.key === "ArrowLeft" || e.key === "PageUp") {
        if (appState.currentPdfPage > 1) {
          appState.currentPdfPage--;
          updatePdfPageView();
        }
      } else if (e.key === "ArrowRight" || e.key === "PageDown") {
        if (appState.currentPdfPage < appState.totalPdfPages) {
          appState.currentPdfPage++;
          updatePdfPageView();
        }
      } else if (e.key === "Escape") {
        viewerModal.style.display = "none";
      }
    }
  });

  eventBus.on("modal:viewer:open", (doc) => openDocumentViewer(doc));
}

export async function openDocumentViewer(doc) {
  const viewerModal = document.getElementById("viewerModal");
  const viewerDocTitle = document.getElementById("viewerDocTitle");
  const viewerDocMeta = document.getElementById("viewerDocMeta");
  const viewerMarkdownContent = document.getElementById("viewerMarkdownContent");

  appState.currentViewingDoc = doc;
  appState.currentViewingPdfPath = doc.path;
  appState.currentViewingMarkdownPath = doc.output_path;
  appState.currentPdfPage = 1;
  appState.totalPdfPages = doc.total_pages || 1;

  if (viewerDocTitle) viewerDocTitle.textContent = doc.name;
  if (viewerDocMeta) viewerDocMeta.textContent = `${doc.total_pages} pages • ${(doc.file_size / 1024).toFixed(0)} KB • ${doc.folder}`;

  if (viewerMarkdownContent) {
    viewerMarkdownContent.innerHTML = `<div class="text-muted text-center" style="padding: 60px;">Loading markdown transcription...</div>`;
  }

  if (viewerModal) viewerModal.style.display = "flex";

  try {
    const res = await fetch(`/api/markdown?path=${encodeURIComponent(doc.path)}`);
    if (!res.ok) throw new Error("Could not load markdown");
    const data = await res.json();

    appState.currentViewingMarkdownContent = data.content;

    if (viewerMarkdownContent) {
      viewerMarkdownContent.innerHTML = markdownRenderer.render(data.content);
    }

    updatePdfPageView();
  } catch (e) {
    if (viewerMarkdownContent) {
      viewerMarkdownContent.innerHTML = `<div class="text-danger text-center" style="padding: 40px;">Error loading markdown: ${e.message}</div>`;
    }
  }
}

function updatePdfPageView() {
  if (!appState.currentViewingPdfPath) return;
  const pdfPageIndicator = document.getElementById("pdfPageIndicator");
  const pdfPageImage = document.getElementById("pdfPageImage");

  if (pdfPageIndicator) pdfPageIndicator.textContent = `Page ${appState.currentPdfPage} / ${appState.totalPdfPages}`;
  if (pdfPageImage) pdfPageImage.src = `/api/page_image?path=${encodeURIComponent(appState.currentViewingPdfPath)}&page=${appState.currentPdfPage}`;
}
