/**
 * GooseQuill — Redrawing the Combiner
 *
 * Five functions each ended with the same sequence: re-render the list,
 * re-suggest the title, update the destination, and kick the preview. Copied
 * into each of them, it was both repetition and the reason the selection code
 * and the list code had to import each other.
 *
 * It happens here instead, once, and the selection functions go back to only
 * changing the selection.
 */

import { renderCombinerFileList } from "./file_list.js";
import { autoSuggestCombinerTitleAndFilename, updateCombinerDestinationText } from "./naming.js";
import { triggerCombinerPreviewDebounced } from "./preview.js";
import { updateCombinerSourceSummary } from "./catalogue.js";
import { toggleCombinerDoc, moveCombinerDoc } from "./selection.js";

/** Redraw the list, wired to the actions its controls need. */
export function renderFileList() {
  renderCombinerFileList({ onToggle: handleToggle, onMove: handleMove });
}

function handleToggle(docPath, isChecked) {
  toggleCombinerDoc(docPath, isChecked);
  refreshCombinerUI();
}

function handleMove(index, direction) {
  moveCombinerDoc(index, direction);
  refreshCombinerUI({ resuggest: false });
}

/**
 * Everything that follows a change to the selection.
 *
 * @param {{resuggest?: boolean, preview?: boolean}} options — reordering does
 *   not change *which* documents were picked, so it leaves the suggested title
 *   alone; the user may have typed their own by then.
 */
export function refreshCombinerUI({ resuggest = true, preview = true } = {}) {
  renderFileList();
  updateCombinerSourceSummary();
  if (resuggest) autoSuggestCombinerTitleAndFilename();
  updateCombinerDestinationText();
  if (preview) triggerCombinerPreviewDebounced();
}
