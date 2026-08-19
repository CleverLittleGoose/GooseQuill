/**
 * GooseQuill — Second Document (Pane B)
 *
 * Pane A stays whatever the Workspace opened; pane B carries its own picker.
 */

import { ComparePane } from "../components/compare_pane.js";
import { studio } from "./state.js";
import * as dom from "./dom.js";
import { updatePdfPageView, syncComparePane } from "./page_view.js";
import { setDiffEnabled, updateDiffAvailability, clearDiffCache } from "./diff.js";

/**
 * Turn the side-by-side view on or off.
 *
 * Turning Compare on hides A's scan so the two transcripts get the full width —
 * A's scan is one click away on the existing scan toggle.
 */
export function setCompareEnabled(enabled) {
  const host = dom.comparePaneHost();
  if (!host) return;

  const pdfPane = dom.pdfPane();
  const togglePdfBtn = dom.togglePdfBtn();

  studio.compareEnabled = enabled;
  host.style.display = enabled ? "flex" : "none";
  dom.compareBtn()?.classList.toggle("active", enabled);

  const linkBtn = dom.linkPagesBtn();
  if (linkBtn) linkBtn.style.display = enabled ? "inline-flex" : "none";

  if (enabled) {
    if (!studio.comparePane) {
      studio.comparePane = new ComparePane(host, {
        label: "B",
        onPageChange: () => {
          // B driving A would fight A driving B; linking is one-way from A.
        },
        onDocumentLoaded: () => {
          updateDiffAvailability();
          // A document swap in B invalidates every cached comparison.
          clearDiffCache();
          if (studio.diffEnabled) setDiffEnabled(true);
        }
      });
    }
    studio.comparePane.populateDocuments();

    // Two documents need the width more than A's scan does.
    if (pdfPane) pdfPane.style.display = "none";
    togglePdfBtn?.classList.remove("active");
    updateLinkPagesButton();
    updateDiffAvailability();
    return;
  }

  if (studio.diffEnabled) setDiffEnabled(false);
  updateDiffAvailability();
  if (pdfPane) {
    pdfPane.style.display = "flex";
    togglePdfBtn?.classList.add("active");
    updatePdfPageView();
  }
}

export function toggleCompare() {
  setCompareEnabled(!studio.compareEnabled);
}

export function toggleLinkPages(currentPage) {
  studio.linkPages = !studio.linkPages;
  updateLinkPagesButton();
  if (studio.linkPages) syncComparePane(currentPage);
}

export function updateLinkPagesButton() {
  const btn = dom.linkPagesBtn();
  if (!btn) return;
  btn.classList.toggle("active", studio.linkPages);
  btn.textContent = studio.linkPages ? "🔗 Link" : "🔗 Link (Off)";
}
