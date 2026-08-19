/**
 * GooseQuill — Studio Pane Splitters
 *
 * Draggable dividers between the page index, the transcript and the scan, with
 * the sizes remembered between sessions.
 */

import * as dom from "./dom.js";

const STORAGE_KEY = "goosequill.studio.panes";
const OUTLINE_MIN_WIDTH = 90;
const OUTLINE_MAX_WIDTH = 320;
const TRANSCRIPT_MIN_FRACTION = 0.2;
const TRANSCRIPT_MAX_FRACTION = 0.8;

function readLayout() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function writeLayout(patch) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readLayout(), ...patch }));
  } catch {
    // A full or blocked localStorage should not stop the pane from resizing.
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

/** Restore the sizes the user last dragged to. */
function applyStoredLayout() {
  const layout = readLayout();
  const outline = dom.outlinePane();
  const markdown = dom.markdownPane();

  if (outline && typeof layout.outlineWidth === "number") {
    outline.style.width = `${clamp(layout.outlineWidth, OUTLINE_MIN_WIDTH, OUTLINE_MAX_WIDTH)}px`;
  }
  if (markdown && typeof layout.transcriptFraction === "number") {
    const fraction = clamp(layout.transcriptFraction, TRANSCRIPT_MIN_FRACTION, TRANSCRIPT_MAX_FRACTION);
    markdown.style.flex = `1 1 ${(fraction * 100).toFixed(2)}%`;
  }
}

/**
 * Make a divider draggable.
 *
 * Pointer capture keeps the drag alive when the cursor outruns the 6px handle,
 * which is most of the time.
 */
function initSplitter(splitterId, onDrag) {
  const splitter = dom.byId(splitterId);
  if (!splitter) return;

  splitter.addEventListener("pointerdown", (event) => {
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
  });

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

export function initStudioSplitters() {
  const outline = dom.outlinePane();
  const markdown = dom.markdownPane();
  const body = document.querySelector(".studio-workspace-body");

  initSplitter("studioSplitterOutline", (clientX) => {
    if (!outline) return;
    const width = clamp(clientX - outline.getBoundingClientRect().left, OUTLINE_MIN_WIDTH, OUTLINE_MAX_WIDTH);
    outline.style.width = `${Math.round(width)}px`;
    writeLayout({ outlineWidth: Math.round(width) });
  });

  initSplitter("studioSplitterMain", (clientX) => {
    if (!markdown || !body) return;
    const markdownLeft = markdown.getBoundingClientRect().left;
    const available = body.getBoundingClientRect().right - markdownLeft;
    if (available <= 0) return;

    const fraction = clamp((clientX - markdownLeft) / available, TRANSCRIPT_MIN_FRACTION, TRANSCRIPT_MAX_FRACTION);
    markdown.style.flex = `1 1 ${(fraction * 100).toFixed(2)}%`;
    writeLayout({ transcriptFraction: fraction });
  });

  applyStoredLayout();
}
