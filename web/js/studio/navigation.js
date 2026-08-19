/**
 * GooseQuill — Page Navigation
 *
 * One way to move the Studio to a page, so the scan, the index and the
 * transcript can never end up describing different pages.
 */

import { appState } from "../state.js";
import { studio } from "./state.js";
import { updatePdfPageView } from "./page_view.js";
import { updateActiveItem } from "./outline.js";
import { updateDisplay } from "./render.js";

/**
 * Move to a page.
 *
 * @param {number} pageNumber
 * @param {boolean} scrollTranscript — whether the transcript should follow.
 *   False when the transcript is what asked for the move in the first place.
 */
export function goToPage(pageNumber, scrollTranscript = true) {
  if (pageNumber < 1 || pageNumber > appState.totalPdfPages) return;

  appState.currentPdfPage = pageNumber;
  updatePdfPageView();
  updateActiveItem();

  if (studio.scope === "page") {
    // In page scope the transcript *is* the page, so it has to be rebuilt.
    updateDisplay();
  } else if (scrollTranscript && studio.autoSync && studio.transcript) {
    studio.transcript.scrollToPage(pageNumber);
  }
}

/** Step one page forward or back. */
export function stepPage(delta) {
  goToPage(appState.currentPdfPage + delta, true);
}
