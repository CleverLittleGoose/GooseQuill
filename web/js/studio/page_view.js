/**
 * GooseQuill — Showing the Current Page
 *
 * Everything that has to change when the active page changes: the scan image,
 * the page indicator, the previous/next buttons, and pane B when it is linked.
 * Zoom lives here too, because the zoom level decides what dpi the scan is
 * fetched at, and the two cannot sensibly be asked separately.
 */

import { appState } from "../state.js";
import { studio } from "./state.js";
import * as dom from "./dom.js";
import { updateToolbarAvailability } from "./availability.js";

// "fit-page" is the default because the previous behaviour — fit-to-width only —
// meant a portrait page was always taller than its pane, so you could never see
// a whole page at once in a tool whose job is checking pages.
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
let zoomMode = "fit-page"; // "fit-page" | "fit-width" | "scale"
let zoomIndex = 2;         // used only when zoomMode === "scale"

/** Render dpi to ask the server for, given how far in we are zoomed. */
function dpiForZoom() {
  if (zoomMode !== "scale") return 150;
  const scale = ZOOM_STEPS[zoomIndex];
  // Past 1.5x a 150dpi raster starts to look soft; ask for more pixels instead.
  return scale > 1.5 ? 300 : 150;
}

/** Keep pane B on the same page number as pane A. */
export function syncComparePane(page) {
  const { compareEnabled, linkPages, comparePane } = studio;
  if (!compareEnabled || !linkPages || !comparePane || !comparePane.doc) return;
  comparePane.goToPage(page);
}

/** Repaint the scan pane for whatever page is current. */
export function updatePdfPageView() {
  syncComparePane(appState.currentPdfPage);
  if (!appState.currentViewingPdfPath) return;

  const indicator = dom.pdfPageIndicator();
  const image = dom.pdfPageImage();
  const prev = dom.pdfPrevBtn();
  const next = dom.pdfNextBtn();

  const imgUrl = `/api/page_image?path=${encodeURIComponent(appState.currentViewingPdfPath)}&page=${appState.currentPdfPage}&dpi=${dpiForZoom()}`;

  if (indicator) indicator.textContent = `Page ${appState.currentPdfPage} of ${appState.totalPdfPages}`;
  if (prev) prev.disabled = appState.currentPdfPage <= 1;
  if (next) next.disabled = appState.currentPdfPage >= appState.totalPdfPages;
  if (image && image.getAttribute("src") !== imgUrl) image.src = imgUrl;
}

export function setZoom(action) {
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

export function applyZoom() {
  const img = dom.pdfPageImage();
  const wrapper = dom.pdfCanvasWrapper();
  const label = dom.pdfZoomLevel();
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

/** Show or hide the scan alongside the transcript. */
export function toggleScanPane() {
  const pane = dom.pdfPane();
  const btn = dom.togglePdfBtn();
  if (!pane) return;
  const wasVisible = pane.style.display !== "none";
  pane.style.display = wasVisible ? "none" : "flex";
  if (btn) {
    btn.classList.toggle("active", !wasVisible);
    btn.setAttribute("aria-pressed", String(!wasVisible));
  }
  if (!wasVisible) updatePdfPageView();
  updateToolbarAvailability();
}
