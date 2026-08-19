/**
 * GooseQuill — Markdown Combiner
 *
 * Wiring only: the controls, connected to the module that knows what each of
 * them means.
 *
 * This replaces `components/combiner_modal.js`, which had grown to 1,089 lines
 * holding the catalogue, the selection, the list rendering, the naming, the
 * preview and the three output paths — and repeated the same five-call refresh
 * sequence at the end of every function that changed anything.
 */

import { appState, eventBus } from "../state.js";
import * as dom from "./dom.js";
import { refreshCombinerAvailableFiles } from "./catalogue.js";
import {
  setupInitialCombinerSelection,
  selectCombinerFolderDocs,
  selectCombinerAllDocs,
  clearCombinerSelection,
  sortCombinerItems,
  applyCombinerSourceFolderFilter
} from "./selection.js";
import { refreshCombinerUI } from "./refresh.js";
import { triggerCombinerPreviewDebounced, generateCombinerPreview } from "./preview.js";
import { updateCombinerDestinationText, autoSuggestCombinerTitleAndFilename } from "./naming.js";
import { saveCombinedMarkdown, copyCombinedMarkdown, downloadCombinedMarkdown } from "./output.js";

export { generateCombinerPreview, refreshCombinerAvailableFiles };
export { renderFileList as renderCombinerFileList } from "./refresh.js";

export function initCombinerModal() {
  wireSourceControls();
  wireOutputSettings();
  wirePreviewTabs();
  wireOutputActions();

  eventBus.on("studio:combiner:activated", () => openCombinerStudio());
  eventBus.on("modal:combiner:open", (paths) => openCombinerStudio(paths));
}

function wireSourceControls() {
  dom.sourceFolderSelect()?.addEventListener("change", (event) => {
    appState.combiner.sourceFolder = event.target.value;
    applyCombinerSourceFolderFilter();
    refreshCombinerUI();
  });

  dom.searchInput()?.addEventListener("input", () => refreshCombinerUI({ resuggest: false, preview: false }));

  dom.byId("studioCombinerSelectFolderBtn")?.addEventListener("click", () => {
    selectCombinerFolderDocs();
    refreshCombinerUI();
  });
  dom.byId("studioCombinerSelectAllBtn")?.addEventListener("click", () => {
    selectCombinerAllDocs();
    refreshCombinerUI();
  });
  dom.byId("studioCombinerDeselectBtn")?.addEventListener("click", () => {
    clearCombinerSelection();
    refreshCombinerUI();
  });

  const sorters = {
    studioCombinerSortChronoAscBtn: "chronological_asc",
    studioCombinerSortChronoDescBtn: "chronological_desc",
    studioCombinerSortAlphaBtn: "alpha_asc"
  };
  Object.entries(sorters).forEach(([id, mode]) => {
    dom.byId(id)?.addEventListener("click", () => {
      sortCombinerItems(mode);
      refreshCombinerUI({ resuggest: false });
    });
  });

  dom.includeConsolidated()?.addEventListener("change", (event) => {
    appState.combiner.includeConsolidated = event.target.checked;
    // Anything already picked that is no longer offered must go with it, or the
    // selection would silently keep a file the list denies exists.
    if (!event.target.checked) {
      appState.combiner.selectedItems = appState.combiner.selectedItems.filter((f) => !f.isConsolidated);
    }
    refreshCombinerUI({ resuggest: false });
  });
}

function wireOutputSettings() {
  dom.masterTitleInput()?.addEventListener("input", triggerCombinerPreviewDebounced);
  dom.outputFilenameInput()?.addEventListener("input", updateCombinerDestinationText);

  dom.targetFolderSelect()?.addEventListener("change", () => {
    updateCombinerDestinationText();
    autoSuggestCombinerTitleAndFilename();
    triggerCombinerPreviewDebounced();
  });

  [dom.includeToc(), dom.includeSourceMeta(), dom.stripHeaders()].forEach((box) => {
    box?.addEventListener("change", triggerCombinerPreviewDebounced);
  });
}

function wirePreviewTabs() {
  const tabs = dom.previewTabs();
  tabs.forEach((btn) => {
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      const target = btn.dataset.tab;
      if (!target) return;

      tabs.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      const rendered = dom.renderedPane();
      const raw = dom.rawPane();
      rendered?.classList.toggle("active", target === "rendered");
      raw?.classList.toggle("active", target !== "rendered");
    });
  });
}

function wireOutputActions() {
  dom.copyBtn()?.addEventListener("click", copyCombinedMarkdown);
  dom.downloadBtn()?.addEventListener("click", downloadCombinedMarkdown);
  dom.saveBtn()?.addEventListener("click", saveCombinedMarkdown);
}

/**
 * Match a set of paths against the catalogue.
 *
 * The Workspace hands over PDF paths and the event bus hands over markdown
 * paths, so this accepts either and tolerates a partial one. It existed twice,
 * once for each caller, differing only in which collection it read.
 */
function matchAvailableFiles(paths) {
  const matched = [];
  paths.forEach((path) => {
    const found = appState.combiner.availableFiles.find(
      (file) =>
        file.path === path ||
        file.name === path ||
        path.endsWith(file.name) ||
        (file.path && file.path.includes(path)) ||
        path.includes(file.stem)
    );
    if (found && !matched.some((m) => m.path === found.path)) matched.push(found);
  });
  return matched;
}

/** Adopt a set of matched documents as the selection. */
function adoptSelection(matched) {
  appState.combiner.selectedItems = matched;
  appState.combiner.sourceFolder = "ALL";

  const picker = dom.sourceFolderSelect();
  if (picker) picker.value = "ALL";
  const notice = dom.folderNotice();
  if (notice) notice.style.display = "none";
}

/**
 * Open the Combiner, carrying over whatever the user had already chosen.
 *
 * Three ways in — an explicit list of paths, a selection made in the Workspace,
 * or neither — and the first two did the same matching work in two copies.
 */
export async function openCombinerStudio(preselectedPaths = null) {
  await refreshCombinerAvailableFiles();

  const incoming = preselectedPaths?.length
    ? preselectedPaths
    : appState.selectedFiles.size
      ? [...appState.selectedFiles]
      : null;

  const matched = incoming ? matchAvailableFiles(incoming) : [];

  if (matched.length > 0) {
    adoptSelection(matched);
  } else {
    setupInitialCombinerSelection();
  }

  sortCombinerItems("chronological_asc");
  refreshCombinerUI();
}
