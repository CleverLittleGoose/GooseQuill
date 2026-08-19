/**
 * GooseQuill — Choosing and Ordering Documents
 *
 * These change the selection and nothing else.
 *
 * They used to each end with the same five calls — re-render the list, re-suggest
 * the title, update the destination, kick the preview — copied into every one of
 * them, which is both repetition and a cycle: the list needs these functions to
 * handle its checkboxes, and these functions needed the list to redraw it. The
 * caller refreshes now, through `refreshCombinerUI`.
 */

import { appState } from "../state.js";
import * as dom from "./dom.js";
import { combinableFiles } from "./catalogue.js";

export function setupInitialCombinerSelection() {
  const sourceFolderSelect = document.getElementById("studioCombinerSourceFolderSelect");
  const targetFolderSelect = document.getElementById("studioCombinerTargetFolderSelect");
  const folderNotice = document.getElementById("studioCombinerFolderNotice");
  const currentFolder = appState.activeFolder;

  appState.combiner.selectedItems = [];

  if (currentFolder && currentFolder !== "ALL") {
    appState.combiner.sourceFolder = currentFolder;
    if (sourceFolderSelect) sourceFolderSelect.value = currentFolder;
    if (targetFolderSelect) targetFolderSelect.value = currentFolder;
    if (folderNotice) folderNotice.style.display = "none";
  } else {
    appState.combiner.sourceFolder = "ALL";
    if (sourceFolderSelect) sourceFolderSelect.value = "ALL";
    if (folderNotice) folderNotice.style.display = "none";
  }
}

export function selectCombinerFolderDocs() {
  const sourceFolder = appState.combiner.sourceFolder || "ALL";
  const targetFolderSelect = document.getElementById("studioCombinerTargetFolderSelect");

  if (sourceFolder === "ALL") {
    selectCombinerAllDocs();
    return;
  }

  if (targetFolderSelect) targetFolderSelect.value = sourceFolder;
  appState.combiner.selectedItems = combinableFiles().filter(f => f.folder === sourceFolder);
  sortCombinerItems("chronological_asc");
}

export function selectCombinerAllDocs() {
  const sourceFolder = appState.combiner.sourceFolder || "ALL";
  if (sourceFolder === "ALL") {
    appState.combiner.selectedItems = [...combinableFiles()];
  } else {
    appState.combiner.selectedItems = combinableFiles().filter(f => f.folder === sourceFolder);
  }
  sortCombinerItems("chronological_asc");
}

export function clearCombinerSelection() {
  appState.combiner.selectedItems = [];
}

export function toggleCombinerDoc(docPath, isChecked) {
  if (isChecked) {
    const item = appState.combiner.availableFiles.find(f => f.path === docPath);
    if (item && !appState.combiner.selectedItems.some(s => s.path === docPath)) {
      appState.combiner.selectedItems.push(item);
    }
  } else {
    appState.combiner.selectedItems = appState.combiner.selectedItems.filter(s => s.path !== docPath);
  }
}

export function moveCombinerDoc(index, direction) {
  const items = appState.combiner.selectedItems;
  const newIndex = index + direction;
  if (newIndex < 0 || newIndex >= items.length) return;

  const temp = items[index];
  items[index] = items[newIndex];
  items[newIndex] = temp;

}

export function sortCombinerItems(mode) {
  appState.combiner.sortMode = mode;
  const items = appState.combiner.selectedItems;

  if (mode === "chronological_asc") {
    items.sort((a, b) => (a.year - b.year) || a.stem.localeCompare(b.stem));
  } else if (mode === "chronological_desc") {
    items.sort((a, b) => (b.year - a.year) || a.stem.localeCompare(b.stem));
  } else if (mode === "alpha_asc") {
    items.sort((a, b) => a.stem.localeCompare(b.stem));
  }

}

export function applyCombinerSourceFolderFilter() {
  const sourceFolder = appState.combiner.sourceFolder || "ALL";
  const folderNotice = document.getElementById("studioCombinerFolderNotice");
  const targetFolderSelect = document.getElementById("studioCombinerTargetFolderSelect");

  if (folderNotice) folderNotice.style.display = "none";

  // Auto-sync Save Destination dropdown to match the selected source folder!
  if (sourceFolder !== "ALL" && targetFolderSelect) {
    targetFolderSelect.value = sourceFolder;
  }

  if (sourceFolder !== "ALL") {
    appState.combiner.selectedItems = appState.combiner.selectedItems.filter(s => s.folder === sourceFolder);
  }

}
