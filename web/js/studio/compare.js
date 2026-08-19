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
import { updateSearchPanePicker } from "./search.js";
import { updateToolbarAvailability } from "./availability.js";

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
  const compareBtn = dom.compareBtn();
  if (compareBtn) {
    compareBtn.classList.toggle("active", enabled);
    compareBtn.setAttribute("aria-pressed", String(enabled));
  }

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
          updateSearchPanePicker();
          updateToolbarAvailability();
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
    togglePdfBtn?.setAttribute("aria-pressed", "false");
    updateLinkPagesButton();
    updateDiffAvailability();
    updateSearchPanePicker();
    updateToolbarAvailability();
    return;
  }

  if (studio.diffEnabled) setDiffEnabled(false);
  updateDiffAvailability();
  updateSearchPanePicker();
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
  // State goes on the button, not into its text: the label is an inline SVG
  // now, and writing textContent would delete it.
  btn.classList.toggle("active", studio.linkPages);
  btn.setAttribute("aria-pressed", String(studio.linkPages));
  btn.title = studio.linkPages
    ? "Both documents stay on the same page number"
    : "Each document scrolls on its own";
}
