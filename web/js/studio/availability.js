/**
 * GooseQuill — What Works Right Now
 *
 * A control that is visible, lit, and does nothing is worse than one that is
 * absent: you press it, nothing happens, and you are left wondering whether you
 * misunderstood the feature or the app is broken.
 *
 * "Sync scan" is the case that prompted this. It keeps the scanned page in step
 * with the transcript — but turning Compare on hides pane A's scan to give the
 * two transcripts the width, so the button sat there, active, governing
 * something that was not on screen.
 *
 * One place decides what is live, so the answer cannot differ between the four
 * modules that can change the mode.
 */

import { studio } from "./state.js";
import * as dom from "./dom.js";
import { hasScan } from "./page_view.js";

/** Whether pane A's scanned page is currently on screen. */
function scanIsVisible() {
  const pane = dom.pdfPane();
  return Boolean(pane && pane.style.display !== "none");
}

/** Whether pane B holds a document to compare against. */
function paneBHasDocument() {
  return Boolean(studio.compareEnabled && studio.comparePane && studio.comparePane.doc);
}

/**
 * Mark a control live or inert.
 *
 * Inert means disabled and explaining itself, not hidden: a control that
 * vanishes and reappears as you change modes is its own kind of confusing, and
 * you cannot learn what you never see.
 */
function setAvailability(button, available, reasonWhenNot) {
  if (!button) return;
  button.disabled = !available;
  button.classList.toggle("is-inert", !available);
  if (!available) {
    button.dataset.liveTitle = button.dataset.liveTitle || button.title;
    button.title = reasonWhenNot;
  } else if (button.dataset.liveTitle) {
    button.title = button.dataset.liveTitle;
  }
}

export function updateToolbarAvailability() {
  setAvailability(
    dom.togglePdfBtn(),
    hasScan(),
    "This document is a consolidation — it has no single scanned page behind it"
  );

  setAvailability(
    dom.autoSyncBtn(),
    scanIsVisible(),
    !hasScan()
      ? "Nothing to sync — this document has no scan behind it"
      : studio.compareEnabled
        ? "Nothing to sync — Compare hides this document's scan to give both transcripts the width"
        : "Nothing to sync — the scan is hidden"
  );

  setAvailability(
    dom.linkPagesBtn(),
    paneBHasDocument(),
    "Choose a document in pane B first"
  );
}
